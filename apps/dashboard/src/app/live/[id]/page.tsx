import Link from "next/link";
import { notFound } from "next/navigation";
import { readState } from "@/lib/server";
import type { AppState, LiveInvoice } from "@/lib/api";
import { formatINR, formatDateShort, formatTs } from "@/lib/format";
import { CallPanel } from "@/components/CallPanel";

export const dynamic = "force-dynamic";

const SUBSTATE: Record<string, { label: string; cls: string; note: string }> = {
  awaiting_reply: { label: "Awaiting reply", cls: "chip-neutral", note: "A message has gone out and the buyer has not answered yet." },
  promised: { label: "Promised", cls: "chip-warning", note: "The buyer gave a date. Nothing will be sent until the day after it." },
  disputed: { label: "Disputed", cls: "chip-alert", note: "The buyer raised a query. Outreach is frozen until you look at it." },
  human_hold: { label: "Waiting on you", cls: "chip-ink", note: "The agent handed this to you. Automation will not act on it again." },
  paid: { label: "Paid", cls: "chip-accent", note: "Razorpay confirmed payment. The campaign has stopped." },
  closed: { label: "Closed", cls: "chip-neutral", note: "This case is finished." },
};

/**
 * Who caused the entry, in terms a merchant recognises. "webhook" covers both
 * a payment landing and a buyer writing back, and naming the subsystem told
 * nobody anything: a promise being recorded was labelled "Razorpay / WhatsApp".
 */
const ACTOR: Record<string, string> = {
  fast: "Rule", agent: "Baaki AI", human: "You", webhook: "From the buyer",
};

/**
 * What happened, in the words a merchant would use.
 *
 * The stored shape is (actor, action), which produced titles like "You: noted"
 * for raising an invoice and "Razorpay / WhatsApp: waited" for a promise
 * freezing outreach. Both are accurate and neither means anything on a screen.
 */
function describe(a: { action: string; actor: string; params: Record<string, unknown> }): string {
  const p = a.params;
  switch (a.action) {
    case "deliver_invoice": {
      const ch = Array.isArray(p.channels) ? (p.channels as string[]) : [];
      const nice = ch.map((c) => (c === "whatsapp" ? "WhatsApp" : c === "email" ? "email" : c));
      return nice.length ? `Invoice sent to the buyer on ${nice.join(" and ")}` : "Invoice could not be sent";
    }
    case "reissue_payment_path":
      return p.failed ? "Could not issue a new payment link" : "New payment link issued";
    case "schedule_wait":
      return a.actor === "webhook" ? "Promise recorded, outreach frozen" : "Waiting on a promise";
    case "open_dispute": return "Dispute opened, outreach stopped";
    case "escalate_to_human": return "Handed to you";
    case "place_call": return p.failed ? "Call could not be placed" : "Called the buyer";
    case "stop": return p.substate === "paid" ? "Paid in full, case closed" : "Case closed";
    case "none":
      if (p.confirmation === "promise") return "Promise confirmed in writing";
      if ("amount" in p) return "Invoice raised";
      if (p.intent) return "Reply read";
      return "Nothing to do";
    default: return a.action.replace(/_/g, " ");
  }
}

function Timeline({ i }: { i: LiveInvoice }) {
  type Ev = { ts: number; kind: string; title: string; who?: string; body?: string; meta?: string; evidence?: string[]; quiet?: boolean };
  const events: Ev[] = [
    ...i.touches.map((t) => ({
      ts: t.ts, kind: "touch",
      title: `Message sent ${t.persona === "owner" ? "from the owner" : "from accounts"} · ${t.rung.replace(/_/g, " ")}`,
      body: t.body,
      meta: t.carriedLiveLink ? "payment link was live" : "payment link had expired",
      evidence: [t.id],
    })),
    ...i.replies.map((r) => ({
      ts: r.ts, kind: "reply",
      title: `Buyer replied · ${r.source === "button" ? "tapped a button" : "wrote a message"}`,
      body: r.text,
      meta: `Read as ${r.intent.replace(/_/g, " ")}${r.promiseDate ? `, ${r.promiseDate}` : ""} · confidence ${r.confidence.toFixed(2)}`,
      evidence: [r.id],
    })),
    ...i.payments.map((p) => ({
      ts: p.ts, kind: "payment",
      title: `Payment received · ${formatINR(p.amount)}`,
      meta: "confirmed by a Razorpay webhook",
      evidence: [p.evidence],
    })),
    ...i.audit.filter((a) => a.action !== "send_nudge").map((a) => ({
      ts: a.ts, kind: "decision",
      title: describe(a),
      who: ACTOR[a.actor] ?? a.actor,
      body: a.rationale,
      meta: a.guards.length ? `${a.guards.filter((g) => g.pass).length} of ${a.guards.length} guards passed` : undefined,
      evidence: a.evidence,
      quiet: a.action === "none" && !("amount" in a.params) && !a.params.confirmation && !a.params.intent,
    })),
  ].sort((a, b) => a.ts - b.ts);

  // Most days the right move is to wait, and a page that prints every one of
  // those days buries the days something happened. Consecutive no-ops collapse
  // into a single line that still says how many there were.
  const rolled: (Ev & { runs?: number })[] = [];
  for (const e of events) {
    const prev = rolled[rolled.length - 1];
    if (e.quiet && prev?.quiet) {
      prev.runs = (prev.runs ?? 1) + 1;
      prev.ts = e.ts;
      prev.body = e.body;
      continue;
    }
    rolled.push({ ...e });
  }

  return (
    <div className="timeline">
      {rolled.map((e, n) => (
        <div className="tl-item" key={n}>
          <span className={`tl-dot ${e.kind}`} />
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {e.runs && e.runs > 1 ? `Checked ${e.runs} days, nothing to do` : e.title}
              </span>
              {e.who && <span className="chip chip-neutral">{e.who}</span>}
              <span className="num" style={{ fontSize: 11, color: "var(--text-4)", marginLeft: "auto" }}>{formatTs(e.ts)}</span>
            </div>
            {e.body && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.55, borderLeft: "2px solid var(--hairline)", paddingLeft: 10 }}>
                {e.body}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 5, alignItems: "center", flexWrap: "wrap" }}>
              {e.meta && <span style={{ fontSize: 11, color: "var(--text-4)" }}>{e.meta}</span>}
              {e.evidence?.map((ev) => <span key={ev} className="evidence">{ev}</span>)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function LiveCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let state: AppState;
  try { state = await readState(); } catch { notFound(); }
  const i = state!.invoices.find((x) => x.invoice.id === id);
  if (!i) notFound();

  const inv = i.invoice;
  const s = SUBSTATE[inv.substate] ?? { label: inv.substate, cls: "chip-neutral", note: "" };
  const today = new Date().toISOString().slice(0, 10);
  const linkDead = inv.linkExpiresOn !== null && inv.linkExpiresOn < today;

  return (
    <div className="container">
      <Link href="/" style={{ fontSize: 12, color: "var(--text-3)" }}>← All invoices</Link>

      <header style={{ display: "flex", alignItems: "flex-start", gap: 16, marginTop: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="h1">{i.buyer.name}</h1>
            <span className={`chip ${s.cls}`}>{s.label}</span>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12, color: "var(--text-3)" }}>
            <span className="mono">{inv.id}</span>
            <span className="mono">+{i.buyer.phone}</span>
            {i.daysOverdue > 0 && <span className="chip chip-warning num">{i.daysOverdue}d late</span>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontSize: 26, fontFamily: "var(--font-serif)" }}>{formatINR(i.outstanding)}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }} className="num">
            {inv.amountPaid > 0 ? `${formatINR(inv.amountPaid)} aa chuka` : `due ${formatDateShort(inv.dueOn)}`}
          </div>
        </div>
      </header>

      <div className="explain" style={{ marginBottom: 20 }}>
        <span className="tag">Where this case stands</span>
        {s.note}{" "}
        {linkDead && <>The payment link has <strong>expired</strong>. The agent will issue a new one before the next message, since a reminder without a working link achieves nothing.</>}
      </div>

      <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          <h2 className="h2" style={{ marginBottom: 14 }}>
            History <span style={{ color: "var(--text-4)" }}>· {i.touches.length + i.replies.length + i.payments.length + i.audit.length} events</span>
          </h2>
          <Timeline i={i} />
        </section>

        <aside style={{ width: 290, flexShrink: 0 }}>
          {inv.substate === "promised" && inv.promisedFor && (
            <div className="panel panel-tint" style={{ marginBottom: 12 }}>
              <div className="overline" style={{ marginBottom: 6 }}>Promised date</div>
              <div className="num" style={{ fontSize: 22, fontFamily: "var(--font-serif)" }}>{formatDateShort(inv.promisedFor)}</div>
              <p className="explain-inline">Nothing will be sent until the day after. If payment has not arrived by then, the agent picks the case up again.</p>
            </div>
          )}

          <CallPanel invoiceId={inv.id} buyerName={i.buyer.name} />

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="overline" style={{ marginBottom: 6 }}>Razorpay</div>
            {i.external.shortUrl ? (
              <>
                <a href={i.external.shortUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--accent-deep)", fontSize: 12, wordBreak: "break-all" }}>
                  {i.external.shortUrl}
                </a>
                <div className="stat-row" style={{ marginTop: 8 }}>
                  <span className="k">Link</span>
                  <span className="v" style={linkDead ? { color: "#b04a28" } : {}}>
                    {linkDead ? `expired ${formatDateShort(inv.linkExpiresOn!)}` : `valid to ${formatDateShort(inv.linkExpiresOn!)}`}
                  </span>
                </div>
              </>
            ) : <p className="explain-inline">No payment link.</p>}
            {i.external.razorpayCustomerId && (
              <div className="stat-row"><span className="k">Customer</span><span className="v mono" style={{ fontSize: 11 }}>{i.external.razorpayCustomerId}</span></div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="overline" style={{ marginBottom: 4 }}>Buyer history</div>
            <div className="stat-row"><span className="k">Average days late</span><span className="v">{i.memory.avgDaysLate.toFixed(1)}</span></div>
            <div className="stat-row">
              <span className="k">Promises kept</span>
              <span className="v">{i.memory.counts.promisesMade === 0 ? "none made yet" : `${i.memory.counts.promisesKept}/${i.memory.counts.promisesMade}`}</span>
            </div>
            <div className="stat-row"><span className="k">Replies per message</span><span className="v">{i.memory.repliesPerTouch.whatsapp.toFixed(2)}</span></div>
            <div className="stat-row"><span className="k">Disputes raised</span><span className="v">{i.memory.counts.disputesRaised}</span></div>
            <div className="stat-row"><span className="k">Do not contact</span><span className="v" style={i.memory.doNotContact ? { color: "#b04a28" } : {}}>{i.memory.doNotContact ? "yes, permanent" : "no"}</span></div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="overline" style={{ marginBottom: 4 }}>Campaign</div>
            <div className="stat-row"><span className="k">Issued</span><span className="v num">{formatDateShort(inv.issuedOn)}</span></div>
            <div className="stat-row"><span className="k">Due</span><span className="v num">{formatDateShort(inv.dueOn)}</span></div>
            <div className="stat-row"><span className="k">Messages sent</span><span className="v">{i.touches.length}</span></div>
            <div className="stat-row"><span className="k">Campaign ends</span><span className="v num">{formatDateShort(inv.campaignEndsOn)}</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
