import Link from "next/link";
import { readState } from "@/lib/server";
import type { AppState, LiveInvoice } from "@/lib/api";
import { formatINR, formatINRCompact, formatDateShort } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_reply: { label: "Awaiting reply", cls: "chip-neutral" },
  promised: { label: "Promised", cls: "chip-warning" },
  disputed: { label: "Disputed", cls: "chip-alert" },
  human_hold: { label: "Waiting on you", cls: "chip-ink" },
  paid: { label: "Paid", cls: "chip-accent" },
  closed: { label: "Closed", cls: "chip-neutral" },
};

function Row({ i, today }: { i: LiveInvoice; today: string }) {
  const s = STATUS[i.invoice.substate] ?? { label: i.invoice.substate, cls: "chip-neutral" };
  const linkDead = i.invoice.linkExpiresOn !== null && i.invoice.linkExpiresOn < today;
  return (
    <Link href={`/live/${i.invoice.id}`} className="row-line" style={{ color: "inherit" }}>
      <span style={{ fontWeight: 500, width: 190, flexShrink: 0 }}>{i.buyer.name}</span>
      <span className="mono" style={{ color: "var(--text-4)", width: 56, flexShrink: 0 }}>{i.invoice.id}</span>
      <span className={`chip ${s.cls}`}>{s.label}</span>
      {i.daysOverdue > 0
        ? <span className="chip chip-warning num">{i.daysOverdue} days overdue</span>
        : <span className="chip chip-neutral">Due {formatDateShort(i.invoice.dueOn)}</span>}
      {linkDead && <span className="chip chip-alert">Payment link expired</span>}
      <span style={{ fontSize: 12, color: "var(--text-3)" }}>
        {i.touches.length} sent · {i.replies.length} replies
      </span>
      <span style={{ marginLeft: "auto", fontWeight: 500 }} className="num">
        {formatINR(i.outstanding)}
      </span>
    </Link>
  );
}

export default async function InvoicesPage() {
  let state: AppState;
  try {
    state = await readState();
  } catch {
    return (
      <div className="container">
        <h1 className="h1">Invoices</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Cannot reach the ledger</span>
          The API did not respond. If you are running locally, start it with{" "}
          <code className="mono">pnpm dev</code>.
        </div>
      </div>
    );
  }

  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const open = state.invoices.filter((i) => !["paid", "closed"].includes(i.invoice.substate));
  const settled = state.invoices.filter((i) => ["paid", "closed"].includes(i.invoice.substate));
  const outstanding = open.reduce((s, i) => s + i.outstanding, 0);
  const collected = state.invoices.reduce((s, i) => s + i.invoice.amountPaid, 0);
  const billed = state.invoices.reduce((s, i) => s + i.invoice.amount, 0);
  const held = open.filter((i) => ["promised", "disputed"].includes(i.invoice.substate));
  const withPeople = open.filter((i) => i.invoice.substate === "human_hold");

  return (
    <div className="container">
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="h1">Invoices</h1>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
            Razorpay handles the money. Baaki handles the chasing.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a className="btn btn-ghost" href="/api/audit?format=csv" title="Every action, its reason and its guard verdicts">
            Audit trail
          </a>
          <Link href="/new" className="btn btn-primary">New invoice</Link>
        </div>
      </header>

      {state.invoices.length === 0 ? (
        <div className="explain">
          <span className="tag">Nothing here yet</span>
          <Link href="/new" style={{ color: "var(--accent-deep)", fontWeight: 500 }}>Create an invoice</Link>{" "}
          to get started. Pick a buyer, set the amount, and choose the rules the agent
          must stay inside. Baaki raises a real Razorpay payment link and takes over
          the follow-up from there.
        </div>
      ) : (
        <>
          <section className="stats" style={{ marginBottom: 24 }}>
            <div className="stat">
              <span className="overline">Outstanding</span>
              <span className="stat-value">{formatINRCompact(outstanding)}</span>
              <span className="stat-sub">{open.length} open</span>
            </div>
            <div className="stat">
              <span className="overline">Recovered</span>
              <span className="stat-value" style={{ color: "var(--accent-deep)" }}>{formatINRCompact(collected)}</span>
              <span className="stat-sub">{billed ? ((collected / billed) * 100).toFixed(0) : 0}% of {formatINRCompact(billed)}</span>
            </div>
            <div className="stat">
              <span className="overline">Overdue</span>
              <span className="stat-value">{open.filter((i) => i.daysOverdue > 0).length}</span>
              <span className="stat-sub">past the due date</span>
            </div>
            <div className="stat">
              <span className="overline">On hold</span>
              <span className="stat-value">{held.length}</span>
              <span className="stat-sub">promise or dispute</span>
            </div>
            <div className="stat">
              <span className="overline">Waiting on you</span>
              <span className="stat-value">{withPeople.length}</span>
              <span className="stat-sub">the agent handed these over</span>
            </div>
          </section>

          <div className="explain" style={{ marginBottom: 20 }}>
            <span className="tag">How this works</span>
            Once a day the agent looks at every open invoice and takes exactly one
            action. Most days that action is to wait. When a buyer replies, Baaki AI
            reads it: a promise freezes outreach until the date they gave, a dispute
            stops it entirely and notifies you. Open any invoice to see everything that
            happened to it, with the reason for each step and the guards it passed.{" "}
            <Link href="/demo" style={{ color: "var(--accent-deep)", fontWeight: 500 }}>Watch a full run</Link>{" "}
            from issue to payment.
          </div>

          {open.length > 0 && (
            <section style={{ marginBottom: 28 }}>
              <h2 className="h2" style={{ marginBottom: 12 }}>
                Open <span style={{ color: "var(--text-4)" }}>· {open.length}</span>
              </h2>
              <div className="card">{open.map((i) => <Row key={i.invoice.id} i={i} today={today} />)}</div>
            </section>
          )}

          {settled.length > 0 && (
            <section>
              <h2 className="h2" style={{ marginBottom: 12 }}>
                Settled <span style={{ color: "var(--text-4)" }}>· {settled.length}</span>
              </h2>
              <div className="card">{settled.map((i) => <Row key={i.invoice.id} i={i} today={today} />)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
