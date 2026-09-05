"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AppState } from "@/lib/api";
import { formatINR } from "@/lib/format";

type Contact = AppState["contacts"][number];

/**
 * The whole arc in one screen: issue the invoice, watch the agent work it, get
 * paid. The only thing simulated is the calendar. Every send on this page is a
 * real one, which is why each step says what actually went out and where the
 * evidence for it is.
 */

interface Step {
  at: string;
  jumped: boolean;
  daysAhead: number;
  looked: number;
  quiet: boolean;
  nextDue: string | null;
  actions: {
    on: string;
    invoiceId: string; buyer: string; route: string; kind: string;
    rung: string | null; rationale: string;
    sent: { messageId: string; template: string | null; dryRun: boolean } | null;
    blocked: string | null;
    guardsFailed: string[];
  }[];
}

const WHAT: Record<string, string> = {
  send_nudge: "Sent a message",
  place_call: "Called the buyer",
  reissue_payment_path: "Issued a fresh payment link",
  schedule_wait: "Waited",
  escalate_to_human: "Handed it to you",
  open_dispute: "Opened a dispute",
  stop: "Closed the case",
  none: "Decided to do nothing",
};

export function DemoRun({ contacts, state, compressed }: { contacts: Contact[]; state: AppState; compressed: boolean }) {
  const sendable = contacts.filter((c) => c.sendable);
  const [contactId, setContactId] = useState(sendable[0]?.id ?? contacts[0]?.id ?? "");
  const [own, setOwn] = useState(sendable.length > 0);
  const [ownName, setOwnName] = useState(sendable[0]?.name ?? "Sharma Traders");
  const [ownPhone, setOwnPhone] = useState(sendable[0]?.phone ?? "");
  const [ownEmail, setOwnEmail] = useState(sendable[0]?.email ?? "");
  const [amount, setAmount] = useState(180000);
  const [termDays, setTermDays] = useState(15);
  const [issuedDaysAgo, setIssuedDaysAgo] = useState(0);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    invoice: { id: string; dueOn: string; amount: number };
    razorpay?: { shortUrl?: string };
    delivered?: { emailRequested: boolean; emailSent: boolean; whatsappMessageId: string | null; whatsappTemplate: string | null; templatePending?: boolean; skipped?: string };
  } | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [clock, setClock] = useState<{ simulatedDate: string; daysAhead: number } | null>(null);
  const [paid, setPaid] = useState<{ amount: number; evidence: string } | null>(null);

  const contact = contacts.find((c) => c.id === contactId);

  useEffect(() => { void refreshClock(); }, []);

  // Once an invoice exists, watch for the payment. Only Razorpay can say money
  // arrived, so this is polling the ledger for the webhook's effect.
  useEffect(() => {
    if (!created || paid) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const j = (await r.json()) as AppState;
        const inv = j.invoices.find((i) => i.invoice.id === created.invoice.id);
        const p = inv?.payments?.[inv.payments.length - 1];
        if (p) setPaid({ amount: p.amount, evidence: p.evidence });
      } catch { /* transient */ }
    }, 4000);
    return () => clearInterval(id);
  }, [created, paid]);

  async function refreshClock() {
    try {
      const r = await fetch("/api/demo", { cache: "no-store" });
      const j = await r.json();
      setClock({ simulatedDate: j.simulatedDate, daysAhead: j.daysAhead });
    } catch { /* not fatal */ }
  }

  async function create() {
    setBusy("create"); setErr(null);
    try {
      let id = contactId;
      // A real number and inbox, so the WhatsApp and the call land somewhere
      // someone is holding. The synthetic book is fine for showing the ledger
      // and useless for showing a message arrive.
      if (own) {
        if (!ownPhone.replace(/\D/g, "")) throw new Error("a phone number is needed for the WhatsApp and the call");
        const cr = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "c_live_demo", name: ownName || "Demo Buyer",
            phone: ownPhone, email: ownEmail || undefined,
            city: "Ludhiana", termDays, language: "hinglish", sendable: true,
          }),
        });
        const cj = await cr.json();
        if (!cr.ok) throw new Error(cj.error ?? "could not save the buyer");
        id = cj.contact.id;
      }
      const r = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: id, amountRupees: amount, termDays, issuedDaysAgo }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "could not create the invoice");
      setCreated(j);
      await refreshClock();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function advance(days?: number) {
    setBusy(days ? `skip${days}` : "advance"); setErr(null);
    try {
      const r = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "advance", ...(days ? { days } : {}) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "could not advance");
      setSteps((s) => [...s, {
        at: j.simulatedDate, jumped: j.jumped, daysAhead: j.daysAhead,
        looked: j.looked, quiet: j.quiet, nextDue: j.nextDue ?? null, actions: j.report.actions,
      }]);
      setClock({ simulatedDate: j.simulatedDate, daysAhead: j.daysAhead });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function setPace(which: "demo" | "live") {
    setBusy("pace");
    try {
      await fetch("/api/demo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "policy", which }),
      });
      window.location.reload();
    } finally { setBusy(null); }
  }

  async function reset() {
    setBusy("reset");
    try {
      await fetch("/api/demo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      setSteps([]); setCreated(null); setPaid(null);
      await refreshClock();
    } finally { setBusy(null); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="explain">
        <span className="tag">What is real here and what is not</span>
        The only thing being simulated is the calendar. Moving the clock forward runs a
        real decision pass: the WhatsApp is really sent, the call is really placed, and
        the guards see the moved date rather than being switched off. At the end you can
        pay the Razorpay link yourself and watch the webhook close the case.
      </div>

      {/* ---- clock ---- */}
      <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <span className="overline">Today, as the agent sees it</span>
          <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {clock?.simulatedDate ?? "loading"}
          </div>
          {clock && clock.daysAhead > 0 && (
            <span className="chip chip-warning" style={{ marginTop: 4 }}>
              {clock.daysAhead} {clock.daysAhead === 1 ? "day" : "days"} ahead of real time
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            className={`chip ${compressed ? "chip-warning" : "chip-neutral"}`}
            style={{ cursor: "pointer", border: "none" }}
            onClick={() => setPace(compressed ? "live" : "demo")}
            disabled={busy !== null}
            title={compressed ? "Switch back to the shipped cadence" : "Compress the cadence to 2 days for a demo"}
          >
            {busy === "pace" ? "…" : compressed ? "2-day demo cadence" : "shipped cadence (10-18 days)"}
          </button>
          <button className="btn btn-ghost" onClick={() => advance(1)} disabled={busy !== null || !created}>
            {busy === "skip1" ? <span className="spinner" /> : "+1 day"}
          </button>
          <button className="btn btn-ghost" onClick={() => advance(2)} disabled={busy !== null || !created}>
            {busy === "skip2" ? <span className="spinner" /> : "+2 days"}
          </button>
          <button className="btn btn-primary" onClick={() => advance()} disabled={busy !== null || !created}>
            {busy === "advance" ? <><span className="spinner" /> Running</> : "Jump to the next action"}
          </button>
          <button className="btn btn-quiet" onClick={reset} disabled={busy !== null}>Reset clock</button>
        </div>
      </div>

      {err && <div className="explain" style={{ borderColor: "#e0b4a4" }}><span className="tag" style={{ color: "#b04a28" }}>Problem</span>{err}</div>}

      {/* ---- step 1: issue ---- */}
      {!created && (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="overline">Step 1 · Raise the invoice</div>
          <p className="explain-inline">
            Put in a number and an inbox you are holding. The WhatsApp and the call go
            there for real, so this is the difference between watching a ledger move and
            watching a message arrive.
          </p>

          <div style={{ display: "flex", gap: 6 }}>
            <button className={`chip ${own ? "chip-accent" : "chip-neutral"}`} style={{ cursor: "pointer", border: "none" }} onClick={() => setOwn(true)}>
              Type a buyer in
            </button>
            <button className={`chip ${!own ? "chip-accent" : "chip-neutral"}`} style={{ cursor: "pointer", border: "none" }} onClick={() => setOwn(false)}>
              Pick from the sample book
            </button>
          </div>

          {own ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="overline">Trader name</span>
                <input className="input" value={ownName} onChange={(e) => setOwnName(e.target.value)} placeholder="Sharma Traders" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="overline">Phone (with country code)</span>
                <input className="input" value={ownPhone} onChange={(e) => setOwnPhone(e.target.value)} placeholder="919000000000" />
                <span className="hint">WhatsApp and the call go here</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="overline">Email</span>
                <input className="input" value={ownEmail} onChange={(e) => setOwnEmail(e.target.value)} placeholder="accounts@example.com" />
                <span className="hint">Razorpay sends the invoice here</span>
              </label>
            </div>
          ) : (
            <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.city}{c.sendable ? " · WhatsApp ready" : ""}{c.email ? " · has email" : " · no email"}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="overline">Amount (rupees)</span>
              <input className="input" type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="overline">Payment terms (days)</span>
              <input className="input" type="number" value={termDays} onChange={(e) => setTermDays(Number(e.target.value))} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="overline">Issued days ago</span>
              <input className="input" type="number" value={issuedDaysAgo} onChange={(e) => setIssuedDaysAgo(Number(e.target.value))} />
              <span className="hint">Backdate it to start partway through the story</span>
            </label>
          </div>
          <div>
            <button className="btn btn-primary" onClick={create} disabled={busy !== null || (!own && !contactId)}>
              {busy === "create" ? <><span className="spinner" /> Raising</> : "Raise the invoice and deliver it"}
            </button>
          </div>
        </div>
      )}

      {/* ---- the arc ---- */}
      {created && (
        <>
          <div className="panel">
            <div className="overline" style={{ marginBottom: 8 }}>Step 1 · Delivered</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{own ? ownName : contact?.name}</strong>
              <span className="num">{formatINR(created.invoice.amount)}</span>
              <span style={{ fontSize: 13, color: "var(--text-3)" }}>due {created.invoice.dueOn}</span>
              <Link href={`/live/${created.invoice.id}`} className="mono" style={{ color: "var(--text-4)" }}>
                {created.invoice.id}
              </Link>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              <span className={`chip ${created.delivered?.emailSent ? "chip-accent" : "chip-neutral"}`}>
                {created.delivered?.emailSent
                  ? "✓ Razorpay emailed it"
                  : created.delivered?.emailRequested ? "email requested, not confirmed" : "no email on file"}
              </span>
              <span className={`chip ${created.delivered?.whatsappMessageId ? "chip-accent" : "chip-neutral"}`}>
                {created.delivered?.whatsappMessageId ? "✓ WhatsApp delivered" : created.delivered?.skipped ?? "WhatsApp not sent"}
              </span>
            </div>
            {created.delivered?.templatePending && (
              <p className="explain-inline" style={{ marginTop: 8 }}>
                The invoice template is still in Meta review, so an approved opener went
                instead. The real template sends the moment Meta approves it.
              </p>
            )}
            {created.delivered?.whatsappMessageId && (
              <p className="explain-inline" style={{ marginTop: 8 }}>
                Message id <span className="evidence">{created.delivered.whatsappMessageId}</span>.
                Delivering the bill is not a reminder, so it does not spend the message budget.
              </p>
            )}
            {created.razorpay?.shortUrl && (
              <p style={{ marginTop: 10, fontSize: 13 }}>
                Live payment link:{" "}
                <a href={created.razorpay.shortUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--accent-deep)" }}>
                  {created.razorpay.shortUrl}
                </a>
              </p>
            )}
          </div>

          {steps.map((s, i) => (
            <div className="panel" key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div className="overline">Step {i + 2} · {s.at}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {s.looked > 1 && (
                    <span className="chip chip-neutral">
                      looked on {s.looked} days, acted on the last
                    </span>
                  )}
                  {s.jumped && <span className="chip chip-neutral">{s.daysAhead} days ahead</span>}
                </div>
              </div>
              {s.actions.length === 0 && (
                <p className="explain-inline" style={{ marginTop: 8 }}>Nothing was open to act on.</p>
              )}
              {s.quiet && (
                <p className="explain-inline" style={{ marginTop: 8 }}>
                  Nothing happened in this stretch. That is the normal case: most days the
                  right move is to wait.
                  {s.nextDue && <> The next thing scheduled is on {s.nextDue}.</>}
                </p>
              )}
              {s.actions.map((a, j) => (
                <div key={j} style={{ marginTop: 10, paddingTop: 10, borderTop: j ? "1px solid var(--hairline)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <span className={`chip ${a.route === "slow" ? "chip-accent" : "chip-neutral"}`}>
                      {a.route === "slow" ? "Baaki AI" : "Rule"}
                    </span>
                    <strong style={{ fontSize: 14 }}>{WHAT[a.kind] ?? a.kind}</strong>
                    {a.rung && <span className="chip chip-outline">{a.rung.replace(/_/g, " ")}</span>}
                    <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{a.buyer}</span>
                    <span className="num" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-4)" }}>{a.on}</span>
                  </div>
                  <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>{a.rationale}</p>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {a.sent && (
                      <span className="chip chip-accent">
                        {a.kind === "place_call" ? "✓ call placed" : "✓ really sent"}
                        {a.sent.dryRun ? " (dry run)" : ""}
                      </span>
                    )}
                    {a.sent?.messageId && <span className="evidence">{a.sent.messageId}</span>}
                    {a.guardsFailed.length > 0 && (
                      <span style={{ fontSize: 11, color: "#b04a28" }}>
                        ✕ refused by {a.guardsFailed.map((g) => g.replace(/_/g, " ")).join(", ")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* ---- the ending ---- */}
          <div className="panel" style={{ borderColor: paid ? "var(--accent-deep)" : undefined }}>
            <div className="overline" style={{ marginBottom: 6 }}>The ending</div>
            {paid ? (
              <>
                <p style={{ fontSize: 15, fontWeight: 500, color: "var(--accent-deep)" }}>
                  Paid. {formatINR(paid.amount)} received.
                </p>
                <p className="explain-inline" style={{ marginTop: 6 }}>
                  Razorpay said so, not this page. Event <span className="evidence">{paid.evidence}</span>,
                  and the case closed itself.{" "}
                  <Link href={`/live/${created.invoice.id}`} style={{ color: "var(--accent-deep)" }}>See the full trail</Link>.
                </p>
              </>
            ) : (
              <p className="explain-inline">
                Pay the link above with a Razorpay test card and this box will fill in on its
                own. Nothing here marks an invoice paid: the webhook does, and only Razorpay
                can send it. Watching for it now.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
