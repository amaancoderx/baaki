import Link from "next/link";
import { readState } from "@/lib/server";
import type { AppState } from "@/lib/api";
import { formatINR, formatINRCompact, formatTs } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Who took the action, in words a merchant uses. The stored actor keys are
 * `fast`, `agent`, `human` and `webhook`, which mean nothing on a screen.
 */
const ACTOR: Record<string, { label: string; cls: string; meaning: string }> = {
  fast: {
    label: "Rule",
    cls: "chip-neutral",
    meaning: "A fixed rule decided it. No model involved.",
  },
  agent: {
    label: "Baaki AI",
    cls: "chip-accent",
    meaning: "The case needed judgement, so it went to the model.",
  },
  human: {
    label: "You",
    cls: "chip-ink",
    meaning: "You took the case over. Automation stopped here.",
  },
  webhook: {
    label: "Razorpay or WhatsApp",
    cls: "chip-warning",
    meaning: "Something happened outside: a payment, or a buyer replied.",
  },
};

const ACTION: Record<string, string> = {
  send_nudge: "sent a message",
  reissue_payment_path: "issued a new payment link",
  schedule_wait: "waited",
  open_dispute: "opened a dispute",
  escalate_to_human: "handed it to you",
  stop: "closed the case",
  none: "noted something",
};

const IST = "Asia/Kolkata";
const dayKey = (ts: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
const dayLabel = (ts: number) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long" }).format(ts);
const timeOnly = (ts: number) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(ts);

export default async function AuditPage() {
  let state: AppState;
  try {
    state = await readState();
  } catch {
    return (
      <div className="container">
        <h1 className="h1">Audit trail</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Cannot reach the ledger</span>
          The ledger could not be read.
        </div>
      </div>
    );
  }

  // Money, and where it came from. Only the payment provider can say a payment
  // happened, so every rupee here traces to a webhook event id.
  const billed = state.invoices.reduce((s, i) => s + i.invoice.amount, 0);
  const collected = state.invoices.reduce((s, i) => s + i.invoice.amountPaid, 0);
  const openInvoices = state.invoices.filter((i) => !["paid", "closed"].includes(i.invoice.substate));
  const outstanding = openInvoices.reduce((s, i) => s + i.outstanding, 0);
  const pctCollected = billed ? (collected / billed) * 100 : 0;

  const payments = state.invoices.flatMap((i) =>
    i.payments.map((p) => ({ ...p, buyer: i.buyer.name, invoiceId: i.invoice.id })),
  ).sort((a, b) => b.ts - a.ts);

  const entries = state.invoices.flatMap((i) =>
    i.audit.map((a) => ({ ...a, buyer: i.buyer.name, invoiceId: i.invoice.id })),
  ).sort((a, b) => b.ts - a.ts);

  const byActor: Record<string, number> = {};
  for (const e of entries) byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;

  const guardsRun = entries.reduce((s, e) => s + e.guards.length, 0);
  const guardsRefused = entries.reduce((s, e) => s + e.guards.filter((g) => !g.pass).length, 0);

  // Grouped by day, newest first, so the log reads as a diary rather than a feed.
  const shown = entries.slice(0, 80);
  const days: { key: string; label: string; rows: typeof shown }[] = [];
  for (const e of shown) {
    const k = dayKey(e.ts);
    const last = days[days.length - 1];
    if (last?.key === k) last.rows.push(e);
    else days.push({ key: k, label: dayLabel(e.ts), rows: [e] });
  }

  const actorsSeen = Object.keys(byActor).filter((k) => ACTOR[k]);

  return (
    <div className="container">
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <h1 className="h1">Audit trail</h1>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
            Every action the system took, why it took it, and the event that proves it.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <a className="btn btn-ghost" href="/api/audit?format=csv">CSV</a>
          <a className="btn btn-ghost" href="/api/audit?format=json">JSON</a>
        </div>
      </header>

      {/* One band, three numbers. The money is the point of the page. */}
      <section className="panel money-band" style={{ marginBottom: 16 }}>
        <div className="money-figures">
          <div>
            <span className="overline">Recovered</span>
            <span className="money-big" style={{ color: "var(--accent-deep)" }}>{formatINRCompact(collected)}</span>
          </div>
          <div>
            <span className="overline">Still outstanding</span>
            <span className="money-big">{formatINRCompact(outstanding)}</span>
          </div>
          <div>
            <span className="overline">Total billed</span>
            <span className="money-big" style={{ color: "var(--text-3)" }}>{formatINRCompact(billed)}</span>
          </div>
        </div>
        <div className="bar" aria-hidden>
          <div className="bar-fill" style={{ width: `${Math.min(100, Math.max(pctCollected, collected > 0 ? 1.5 : 0))}%` }} />
        </div>
        <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>
          {pctCollected.toFixed(1)}% collected across {state.invoices.length} invoices.{" "}
          {openInvoices.length} still open. Every rupee arrived through a Razorpay
          webhook, never a manual entry.
        </p>
      </section>

      <div className="explain" style={{ marginBottom: 24 }}>
        <span className="tag">How to read this page</span>
        Nothing here is written by hand. It is the append-only log, rendered. Each
        payment carries the Razorpay event id that reported it, and each action
        carries the reason it was taken plus the guard checks it had to pass before
        it could go out. {guardsRun} guard checks have run so far and{" "}
        {guardsRefused === 0 ? "none refused an action" : `${guardsRefused} refused an action`}.
      </div>

      {payments.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h2 className="h2" style={{ marginBottom: 4 }}>
            Money received <span style={{ color: "var(--text-4)" }}>· {payments.length}</span>
          </h2>
          <p className="explain-inline" style={{ marginBottom: 10 }}>
            The grey code on each row is the Razorpay event id. The same id appears
            in the action log below, so any rupee can be traced to its source.
          </p>
          <div className="card">
            {payments.map((p) => (
              <div className="row-line" key={p.id}>
                <span style={{ fontWeight: 500, width: 180 }}>{p.buyer}</span>
                <Link href={`/live/${p.invoiceId}`} className="mono" style={{ color: "var(--text-4)", width: 60 }}>
                  {p.invoiceId}
                </Link>
                <span className="num" style={{ fontWeight: 500, color: "var(--accent-deep)" }}>
                  {formatINR(p.amount)}
                </span>
                <span className="evidence">{p.evidence}</span>
                <span className="num" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-4)" }}>
                  {formatTs(p.ts)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="h2" style={{ marginBottom: 4 }}>
          What the system did <span style={{ color: "var(--text-4)" }}>· {entries.length}</span>
        </h2>
        <p className="explain-inline" style={{ marginBottom: 12 }}>
          Newest first. The tag on each row says who decided it.
        </p>

        <div className="legend">
          {actorsSeen.map((k) => (
            <div className="legend-item" key={k}>
              <span className={`chip ${ACTOR[k]!.cls}`}>{ACTOR[k]!.label}</span>
              <span className="legend-text">
                {ACTOR[k]!.meaning} <span style={{ color: "var(--text-4)" }}>{byActor[k]} so far.</span>
              </span>
            </div>
          ))}
        </div>

        {days.map((d) => (
          <div key={d.key} style={{ marginTop: 16 }}>
            <div className="day-head">
              <span>{d.label}</span>
              <span style={{ color: "var(--text-4)", fontWeight: 400 }}>
                {d.rows.length} {d.rows.length === 1 ? "action" : "actions"}
              </span>
            </div>
            <div className="card">
              {d.rows.map((e) => {
                const failed = e.guards.filter((g) => !g.pass);
                const actor = ACTOR[e.actor];
                return (
                  <div key={e.id} className="audit-row">
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span className={`chip ${actor?.cls ?? "chip-neutral"}`}>{actor?.label ?? e.actor}</span>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{ACTION[e.action] ?? e.action}</span>
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>for {e.buyer}</span>
                      <Link href={`/live/${e.invoiceId}`} className="mono" style={{ color: "var(--text-4)" }}>
                        {e.invoiceId}
                      </Link>
                      <span className="num" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-4)" }}>
                        {timeOnly(e.ts)}
                      </span>
                    </div>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
                      {e.rationale}
                    </p>
                    <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {e.guards.length > 0 && (
                        <span style={{ fontSize: 11, color: failed.length ? "#b04a28" : "var(--accent-deep)" }}>
                          {failed.length === 0
                            ? `✓ passed all ${e.guards.length} guard checks`
                            : `✕ refused by ${failed.map((g) => g.name.replace(/_/g, " ")).join(", ")}`}
                        </span>
                      )}
                      {e.evidence.map((ev) => <span key={ev} className="evidence">{ev}</span>)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {entries.length > shown.length && (
          <p className="explain-inline" style={{ marginTop: 12 }}>
            Showing the {shown.length} most recent of {entries.length}. Download the
            full trail as CSV or JSON above.
          </p>
        )}
      </section>
    </div>
  );
}
