import Link from "next/link";
import { readState } from "@/lib/server";
import type { AppState, LiveInvoice } from "@/lib/api";
import { formatINR, formatINRCompact, formatDateShort } from "@/lib/format";

export const dynamic = "force-dynamic";

const SUBSTATE_HI: Record<string, { hi: string; cls: string }> = {
  awaiting_reply: { hi: "jawab ka intezaar", cls: "chip-neutral" },
  promised: { hi: "promise mila hai", cls: "chip-warning" },
  disputed: { hi: "dispute khula hai", cls: "chip-alert" },
  human_hold: { hi: "insaan ke paas", cls: "chip-ink" },
  paid: { hi: "paisa aa gaya", cls: "chip-accent" },
  closed: { hi: "band", cls: "chip-neutral" },
};

function Row({ i }: { i: LiveInvoice }) {
  const s = SUBSTATE_HI[i.invoice.substate] ?? { hi: i.invoice.substate, cls: "chip-neutral" };
  const linkDead = i.invoice.linkExpiresOn !== null &&
    i.invoice.linkExpiresOn < new Date().toISOString().slice(0, 10);
  return (
    <Link href={`/live/${i.invoice.id}`} className="row-line" style={{ color: "inherit" }}>
      <span style={{ fontWeight: 500, width: 190, flexShrink: 0 }}>{i.buyer.name}</span>
      <span className="mono" style={{ color: "var(--text-4)", width: 56, flexShrink: 0 }}>{i.invoice.id}</span>
      <span className={`chip ${s.cls}`}>{s.hi}</span>
      {i.daysOverdue > 0
        ? <span className="chip chip-warning num">{i.daysOverdue}d late</span>
        : <span className="chip chip-neutral">due {formatDateShort(i.invoice.dueOn)}</span>}
      {linkDead && <span className="chip chip-alert">link expire</span>}
      <span style={{ fontSize: 12, color: "var(--text-3)" }}>
        {i.touches.length} msg · {i.replies.length} reply
      </span>
      <span style={{ marginLeft: "auto", fontWeight: 500 }} className="num">
        {formatINR(i.outstanding)}
      </span>
    </Link>
  );
}

export default async function TodayPage() {
  let state: AppState;
  try {
    state = await readState();
  } catch {
    return (
      <div className="container">
        <h1 className="h1">Today</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Service band hai</span>
          Webhook service nahi chal raha, isliye ledger nahi padh paya.
          Terminal mein <code className="mono">pnpm webhook</code> chalao aur refresh karo.
        </div>
      </div>
    );
  }

  const open = state.invoices.filter((i) => !["paid", "closed"].includes(i.invoice.substate));
  const settled = state.invoices.filter((i) => ["paid", "closed"].includes(i.invoice.substate));
  const outstanding = open.reduce((s, i) => s + i.outstanding, 0);
  const collected = state.invoices.reduce((s, i) => s + i.invoice.amountPaid, 0);
  const billed = state.invoices.reduce((s, i) => s + i.invoice.amount, 0);

  return (
    <div className="container">
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="h1">Today</h1>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
            Aapka live ledger. Razorpay se paisa aata hai, Baaki chasing sambhalta hai.
          </p>
        </div>
        <Link href="/new" className="btn btn-primary">Naya invoice</Link>
      </header>

      {state.invoices.length === 0 ? (
        <div className="explain">
          <span className="tag">Shuruaat karo</span>
          Abhi koi invoice nahi hai. <Link href="/new" style={{ color: "var(--accent-deep)", fontWeight: 500 }}>Naya invoice</Link>{" "}
          banao — buyer chuno, amount daalo, rules set karo. Razorpay pe asli payment
          link banega, aur uske baad agent khud follow-up karega.
        </div>
      ) : (
        <>
          <section className="stats" style={{ marginBottom: 24 }}>
            <div className="stat">
              <span className="overline">Baaki hai</span>
              <span className="stat-value">{formatINRCompact(outstanding)}</span>
              <span className="stat-sub">{open.length} khule invoice</span>
            </div>
            <div className="stat">
              <span className="overline">Aa gaya</span>
              <span className="stat-value">{formatINRCompact(collected)}</span>
              <span className="stat-sub">{billed ? ((collected / billed) * 100).toFixed(0) : 0}% of {formatINRCompact(billed)}</span>
            </div>
            <div className="stat">
              <span className="overline">Late</span>
              <span className="stat-value">{open.filter((i) => i.daysOverdue > 0).length}</span>
              <span className="stat-sub">due date nikal gaya</span>
            </div>
            <div className="stat">
              <span className="overline">Roka hua</span>
              <span className="stat-value">{open.filter((i) => ["promised", "disputed"].includes(i.invoice.substate)).length}</span>
              <span className="stat-sub">promise ya dispute</span>
            </div>
            <div className="stat">
              <span className="overline">Insaan ke paas</span>
              <span className="stat-value">{open.filter((i) => i.invoice.substate === "human_hold").length}</span>
              <span className="stat-sub">agent ne haath khada kiya</span>
            </div>
          </section>

          <div className="explain" style={{ marginBottom: 16 }}>
            <span className="tag">Ye kaise chalta hai</span>
            Har din agent har khule invoice ko dekhta hai aur ek action leta hai.
            Zyada tar din kuch karna hi nahi hota. Jab buyer WhatsApp pe reply karta
            hai, Gemini use padhta hai — promise mila to outreach freeze, dispute hua
            to insaan ko. <Link href="/run" style={{ color: "var(--accent-deep)", fontWeight: 500 }}>Agent chalao</Link> aur khud dekho.
          </div>

          {open.length > 0 && (
            <section style={{ marginBottom: 28 }}>
              <h2 className="h2" style={{ marginBottom: 12 }}>Khule <span style={{ color: "var(--text-4)" }}>· {open.length}</span></h2>
              <div className="card">{open.map((i) => <Row key={i.invoice.id} i={i} />)}</div>
            </section>
          )}

          {settled.length > 0 && (
            <section>
              <h2 className="h2" style={{ marginBottom: 12 }}>Ho gaye <span style={{ color: "var(--text-4)" }}>· {settled.length}</span></h2>
              <div className="card">{settled.map((i) => <Row key={i.invoice.id} i={i} />)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
