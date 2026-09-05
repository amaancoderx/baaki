import Link from "next/link";
import { Journey } from "@/components/Journey";
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
function Timeline({ i }: { i: LiveInvoice }) {
  // Same eyes as the demo screen: one ledger, one way of reading it.
  return <Journey inv={i} />;
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
