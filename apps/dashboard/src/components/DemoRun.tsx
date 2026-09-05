"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState } from "@/lib/api";
import { formatINR } from "@/lib/format";

type Contact = AppState["contacts"][number];
type Inv = AppState["invoices"][number];

/**
 * A living timeline of one invoice.
 *
 * The screen follows a single case from issue to payment, with the calendar as
 * the only simulated thing: every send on it is a real send and every decision
 * came from the production router and guards. The whole book still gets worked
 * on each tick; this screen just doesn't narrate the rest of it.
 */

const DAY = 86_400_000;

interface Ev {
  ts: number;
  day: number;
  kind: "issue" | "wait" | "send" | "reply" | "call" | "payment" | "decision" | "blocked";
  title: string;
  body?: string;
  meta?: string;
  runs?: number;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_reply: { label: "Payment pending", cls: "chip-neutral" },
  promised: { label: "Promise in flight", cls: "chip-accent" },
  disputed: { label: "Disputed", cls: "chip-alert" },
  human_hold: { label: "Waiting on you", cls: "chip-ink" },
  paid: { label: "Paid ✓", cls: "chip-accent" },
  closed: { label: "Closed", cls: "chip-neutral" },
};

function dayOf(ts: number, issuedOn: string): number {
  return Math.max(0, Math.floor((ts - Date.parse(`${issuedOn}T00:00:00+05:30`)) / DAY));
}

function buildTimeline(i: Inv): { events: Ev[]; nextOn: string | null } {
  const issued = i.invoice.issuedOn;
  const evs: Ev[] = [];
  let nextOn: string | null = null;

  for (const a of i.audit) {
    const p = a.params as Record<string, unknown>;
    if (typeof p.nextReviewAt === "string") nextOn = p.nextReviewAt;
    const base = { ts: a.ts, day: dayOf(a.ts, issued) };

    if (a.action === "none" && "amount" in p) {
      evs.push({ ...base, kind: "issue", title: `Invoice created · ${formatINR(i.invoice.amount)}`, body: a.rationale });
    } else if (a.action === "deliver_invoice") {
      const ch = Array.isArray(p.channels) ? (p.channels as string[]).map((c) => (c === "whatsapp" ? "WhatsApp" : "Email")) : [];
      evs.push({ ...base, kind: "send", title: ch.length ? `Invoice sent · ${ch.join(" + ")}` : "Invoice could not be sent", body: a.rationale });
    } else if (a.action === "none" && p.confirmation === "promise") {
      evs.push({ ...base, kind: "send", title: "Promise confirmed in writing · WhatsApp", body: a.rationale });
    } else if (a.action === "none" && p.intent) {
      // the reply itself renders from i.replies; skip the bookkeeping twin
    } else if (a.action === "none" || a.action === "schedule_wait") {
      evs.push({ ...base, kind: "wait", title: "AI decided to wait", body: a.rationale });
    } else if (a.action === "place_call") {
      evs.push({ ...base, kind: "call", title: p.failed ? "Call could not be placed" : "AI called the buyer", body: a.rationale, meta: typeof p.callSid === "string" ? `call ${String(p.callSid).slice(0, 18)}` : undefined });
    } else if (a.action === "reissue_payment_path") {
      evs.push({ ...base, kind: "decision", title: p.failed ? "Could not refresh the payment link" : "Fresh payment link issued", body: a.rationale });
    } else if (a.action === "escalate_to_human") {
      evs.push({ ...base, kind: "decision", title: "Handed to you", body: a.rationale });
    } else if (a.action === "open_dispute") {
      evs.push({ ...base, kind: "decision", title: "Dispute opened, outreach stopped", body: a.rationale });
    } else if (a.action === "stop") {
      evs.push({ ...base, kind: "payment", title: "AI closed the collection journey", body: a.rationale });
    } else if (Array.isArray(p.refusedBy) && p.refusedBy.length) {
      evs.push({ ...base, kind: "blocked", title: `Guard refused: ${(p.refusedBy as string[]).join(", ").replace(/_/g, " ")}`, body: a.rationale });
    }
  }

  for (const t of i.touches) {
    evs.push({
      ts: t.ts, day: dayOf(t.ts, issued), kind: "send",
      title: `Follow-up sent · WhatsApp${(t as { emailed?: boolean }).emailed ? " + Email" : ""} · ${t.rung.replace(/_/g, " ")}`,
      body: t.body,
    });
  }
  for (const r of i.replies) {
    evs.push({
      ts: r.ts, day: dayOf(r.ts, issued), kind: "reply",
      title: "Buyer replied",
      body: `“${r.text}”`,
      meta: `AI understood: ${r.intent.replace(/_/g, " ")}${r.promiseDate ? `, expected by ${r.promiseDate}` : ""}`,
    });
  }
  for (const pmt of i.payments) {
    evs.push({
      ts: pmt.ts, day: dayOf(pmt.ts, issued), kind: "payment",
      title: `Payment received · ${formatINR(pmt.amount)}`,
      meta: `Razorpay event ${pmt.evidence}`,
    });
  }

  evs.sort((a, b) => a.ts - b.ts);

  // Consecutive waits collapse: doing nothing is a decision worth one line, not five.
  const rolled: Ev[] = [];
  for (const e of evs) {
    const prev = rolled[rolled.length - 1];
    if (e.kind === "wait" && prev?.kind === "wait") {
      prev.runs = (prev.runs ?? 1) + 1;
      prev.ts = e.ts; prev.day = e.day; prev.body = e.body;
      continue;
    }
    rolled.push({ ...e });
  }
  return { events: rolled, nextOn };
}

const DOT: Record<Ev["kind"], string> = {
  issue: "🧾", wait: "🤖", send: "📨", reply: "💬", call: "📞",
  payment: "✅", decision: "🤖", blocked: "🛡️",
};

export function DemoRun({ contacts, state, compressed }: { contacts: Contact[]; state: AppState; compressed: boolean }) {
  const sendable = contacts.filter((c) => c.sendable);
  const [contactId, setContactId] = useState(sendable[0]?.id ?? contacts[0]?.id ?? "");
  const [own, setOwn] = useState(true);
  const [ownName, setOwnName] = useState(sendable[0]?.name ?? "Krishna Enterprises");
  const [ownPhone, setOwnPhone] = useState(sendable[0]?.phone ?? "");
  const [ownEmail, setOwnEmail] = useState(sendable[0]?.email ?? "");
  const [amount, setAmount] = useState(180000);
  const [termDays, setTermDays] = useState(10);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [invId, setInvId] = useState<string | null>(null);

  // Reloading the page must not forget which invoice the demo is following.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("baaki-demo-inv") : null;
    if (saved) { setInvId(saved); void refresh(saved); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [inv, setInv] = useState<Inv | null>(null);
  const [clock, setClock] = useState<{ simulatedDate: string; daysAhead: number } | null>(null);
  const [lastNote, setLastNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (id?: string | null) => {
    try {
      const [cR, sR] = await Promise.all([
        fetch("/api/demo", { cache: "no-store" }),
        fetch("/api/state", { cache: "no-store" }),
      ]);
      const c = await cR.json();
      setClock({ simulatedDate: c.simulatedDate, daysAhead: c.daysAhead });
      const s = (await sR.json()) as AppState;
      const target = id ?? invId;
      if (target) setInv(s.invoices.find((x) => x.invoice.id === target) ?? null);
    } catch { /* transient */ }
  }, [invId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // While the invoice is unpaid, keep watching: the payment arrives as a
  // webhook, and the reply you send from your phone arrives the same way.
  useEffect(() => {
    if (!invId) return;
    const t = setInterval(() => { void refresh(invId); }, 5000);
    return () => clearInterval(t);
  }, [invId, refresh]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [inv?.audit?.length]);

  async function create() {
    setBusy("create"); setErr(null);
    try {
      let id = contactId;
      if (own) {
        if (!ownPhone.replace(/\D/g, "")) throw new Error("a phone number is needed: the WhatsApp and the call go there");
        const cr = await fetch("/api/contacts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "c_live_demo", name: ownName || "Demo Buyer", phone: ownPhone, email: ownEmail || undefined, city: "Ludhiana", termDays, language: "hinglish", sendable: true }),
        });
        const cj = await cr.json();
        if (!cr.ok) throw new Error(cj.error ?? "could not save the buyer");
        id = cj.contact.id;
      }
      const r = await fetch("/api/invoices", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: id, amountRupees: amount, termDays }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "could not create the invoice");
      setInvId(j.invoice.id);
      window.localStorage.setItem("baaki-demo-inv", j.invoice.id);
      await refresh(j.invoice.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function advance(days?: number) {
    setBusy(days ? `d${days}` : "jump"); setErr(null); setLastNote(null);
    try {
      const r = await fetch("/api/demo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "advance", ...(days ? { days } : {}) }),
      });
      const j = await r.json();
      if (r.status === 409) {
        // The previous jump is still working the book. Not an error worth a red
        // box: the poll below picks its results up as they land.
        setLastNote("Still finishing the previous jump. Give it a few seconds.");
      } else if (!r.ok) {
        throw new Error(j.error ?? "could not advance");
      } else {
        const mine = (j.report?.actions ?? []).filter((a: { invoiceId: string; kind: string }) => a.invoiceId === invId && a.kind !== "none");
        setLastNote(mine.length === 0 ? "Moved forward. The AI looked at this invoice and chose to wait." : null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      // Refresh regardless of how the request ended. A timeout or a held lock
      // does not mean nothing happened; it usually means the opposite, and the
      // screen going quiet while an email lands reads as a broken page.
      await refresh(invId);
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      await fetch("/api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) });
      setInvId(null); setInv(null); setLastNote(null);
      window.localStorage.removeItem("baaki-demo-inv");
      await refresh(null);
    } finally { setBusy(null); }
  }

  const tl = inv ? buildTimeline(inv) : null;
  const paid = inv ? ["paid", "closed"].includes(inv.invoice.substate) : false;
  const st = inv ? STATUS[inv.invoice.substate] ?? STATUS.awaiting_reply! : null;
  const simDay = inv && clock ? dayOf(Date.parse(`${clock.simulatedDate}T12:00:00+05:30`), inv.invoice.issuedOn) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---------- time simulator ---------- */}
      <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", position: "sticky", top: 8, zIndex: 20, boxShadow: "var(--shadow-float)" }}>
        <div>
          <span className="overline">Simulated date</span>
          <div style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {clock?.simulatedDate ?? "…"}
            {simDay !== null && <span style={{ fontSize: 13, color: "var(--text-3)", marginLeft: 10 }}>Day {simDay}</span>}
          </div>
          {clock && clock.daysAhead > 0 && (
            <span className="chip chip-warning" style={{ marginTop: 4 }}>{clock.daysAhead} days ahead of real time</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {compressed && <span className="chip chip-warning">2-day demo cadence</span>}
          <button className="btn btn-ghost" onClick={() => advance(1)} disabled={busy !== null || !invId || paid}>
            {busy === "d1" ? <span className="spinner" /> : "+1 day"}
          </button>
          <button className="btn btn-ghost" onClick={() => advance(2)} disabled={busy !== null || !invId || paid}>
            {busy === "d2" ? <span className="spinner" /> : "+2 days"}
          </button>
          <button className="btn btn-primary" onClick={() => advance()} disabled={busy !== null || !invId || paid}>
            {busy === "jump" ? <><span className="spinner" /> Running</> : "Jump to next AI action"}
          </button>
          <button className="btn btn-quiet" onClick={reset} disabled={busy !== null}>Reset</button>
        </div>
      </div>

      {err && <div className="explain" style={{ borderColor: "#e0b4a4" }}><span className="tag" style={{ color: "#b04a28" }}>Problem</span>{err}</div>}

      {/* ---------- create ---------- */}
      {!inv && (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="overline">Create the invoice</div>
          <p className="explain-inline">
            The WhatsApp and the phone call really go to this number, and Razorpay
            really emails this inbox. Use ones you are holding.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <button className={`chip ${own ? "chip-accent" : "chip-neutral"}`} style={{ cursor: "pointer", border: "none" }} onClick={() => setOwn(true)}>Type a buyer in</button>
            <button className={`chip ${!own ? "chip-accent" : "chip-neutral"}`} style={{ cursor: "pointer", border: "none" }} onClick={() => setOwn(false)}>Pick from the book</button>
          </div>
          {own ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="overline">Buyer name</span>
                <input className="input" value={ownName} onChange={(e) => setOwnName(e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="overline">Phone (with country code)</span>
                <input className="input" value={ownPhone} onChange={(e) => setOwnPhone(e.target.value)} placeholder="9195XXXXXXXX" />
                <span className="hint">WhatsApp and the call land here</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="overline">Email</span>
                <input className="input" value={ownEmail} onChange={(e) => setOwnEmail(e.target.value)} placeholder="accounts@…" />
                <span className="hint">Razorpay emails the invoice here</span>
              </label>
            </div>
          ) : (
            <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.city}{c.sendable ? " · reachable" : " · sample data"}</option>
              ))}
            </select>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 420 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="overline">Amount (₹)</span>
              <input className="input" type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="overline">Due in (days)</span>
              <input className="input" type="number" value={termDays} onChange={(e) => setTermDays(Number(e.target.value))} />
            </label>
          </div>
          <div>
            <button className="btn btn-primary" onClick={create} disabled={busy !== null || (!own && !contactId)}>
              {busy === "create" ? <><span className="spinner" /> Creating and sending</> : "Create invoice · Day 0"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- the invoice card ---------- */}
      {inv && (
        <div className="panel" style={{ borderColor: paid ? "var(--accent-deep)" : undefined }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 17 }}>{inv.buyer.name}</strong>
            <span className={`chip ${st!.cls}`}>{st!.label}</span>
            {!paid && inv.daysOverdue > 0 && <span className="chip chip-alert">{inv.daysOverdue}d overdue</span>}
            <span className="mono" style={{ color: "var(--text-4)" }}>{inv.invoice.id}</span>
            <span className="num" style={{ marginLeft: "auto", fontSize: 20, fontWeight: 500, color: paid ? "var(--accent-deep)" : "var(--ink)" }}>
              {paid ? `${formatINR(inv.invoice.amountPaid)} paid` : `${formatINR(inv.outstanding)} due`}
            </span>
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 8, fontSize: 12, color: "var(--text-3)", flexWrap: "wrap" }}>
            <span>Issued {inv.invoice.issuedOn}</span>
            <span>Due {inv.invoice.dueOn}</span>
            {!paid && inv.external?.shortUrl && (
              <a href={inv.external.shortUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--accent-deep)" }}>
                {inv.external.shortUrl}
              </a>
            )}
          </div>
        </div>
      )}

      {/* ---------- the living timeline ---------- */}
      {inv && tl && (
        <div className="panel">
          <div className="overline" style={{ marginBottom: 12 }}>The journey</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {tl.events.map((e, n) => {
              const newDay = n === 0 || tl.events[n - 1]!.day !== e.day;
              return (
                <div key={n}>
                  {newDay && (
                    <div className="day-head" style={{ paddingTop: n ? 14 : 0 }}>
                      <span>DAY {e.day}</span>
                      <span style={{ color: "var(--text-4)", fontWeight: 400 }}>
                        {new Date(e.ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}
                      </span>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10, padding: "8px 2px", borderLeft: "2px solid var(--hairline)", marginLeft: 6, paddingLeft: 14 }}>
                    <span style={{ fontSize: 15, lineHeight: "20px" }}>{DOT[e.kind]}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {e.runs && e.runs > 1 ? `AI checked ${e.runs} times, chose to wait` : e.title}
                      </div>
                      {e.body && <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 2 }}>{e.body}</div>}
                      {e.meta && <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 2 }}>{e.meta}</div>}
                    </div>
                  </div>
                </div>
              );
            })}

            {lastNote && !paid && (
              <div style={{ display: "flex", gap: 10, padding: "8px 2px", borderLeft: "2px solid var(--hairline)", marginLeft: 6, paddingLeft: 14 }}>
                <span style={{ fontSize: 15 }}>🤖</span>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{lastNote}</div>
              </div>
            )}

            {/* what happens next */}
            {!paid && (
              <div className="explain" style={{ marginTop: 14 }}>
                <span className="tag">Next AI action</span>
                {tl.nextOn
                  ? <>Scheduled for <strong>{tl.nextOn}</strong>. Jump the clock there and it happens for real.</>
                  : <>The AI reviews this invoice on the next day it runs.</>}
                {" "}Reply to the WhatsApp from your phone at any point: the reply lands
                here, is read, and changes what the AI does next.
              </div>
            )}

            {paid && (
              <div className="explain" style={{ marginTop: 14, borderColor: "var(--accent-deep)" }}>
                <span className="tag">Journey complete</span>
                Payment received and confirmed by a Razorpay webhook, never a manual entry.
                {" "}{formatINR(inv.invoice.amountPaid)} collected. Outstanding ₹0. The full
                trail above is the append-only audit log, rendered.
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>
      )}
    </div>
  );
}
