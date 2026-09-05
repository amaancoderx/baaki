import Link from "next/link";
import { readState } from "@/lib/server";
import type { AppState } from "@/lib/api";
import { formatINR, formatINRCompact, formatTs } from "@/lib/format";

export const dynamic = "force-dynamic";

const ACTOR_HI: Record<string, string> = {
  fast: "rule", agent: "Gemini agent", human: "insaan", webhook: "Razorpay / WhatsApp",
};
const ACTION_HI: Record<string, string> = {
  send_nudge: "message bheja",
  reissue_payment_path: "naya payment link banaya",
  schedule_wait: "wait kiya",
  open_dispute: "dispute khola",
  escalate_to_human: "insaan ko diya",
  stop: "band kiya",
  none: "note",
};
const ACTOR_CLS: Record<string, string> = {
  fast: "chip-neutral", agent: "chip-accent", human: "chip-ink", webhook: "chip-warning",
};

export default async function AuditPage() {
  let state: AppState;
  try {
    state = await readState();
  } catch {
    return (
      <div className="container">
        <h1 className="h1">Audit trail</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Service band hai</span>
          Ledger padha nahi ja saka.
        </div>
      </div>
    );
  }

  // Money, and where it came from. Only the payment provider can say a payment
  // happened, so every rupee here traces to a webhook event id.
  const billed = state.invoices.reduce((s, i) => s + i.invoice.amount, 0);
  const collected = state.invoices.reduce((s, i) => s + i.invoice.amountPaid, 0);
  const outstanding = state.invoices.reduce(
    (s, i) => s + (["paid", "closed"].includes(i.invoice.substate) ? 0 : i.outstanding), 0);

  const payments = state.invoices.flatMap((i) =>
    i.payments.map((p) => ({ ...p, buyer: i.buyer.name, invoiceId: i.invoice.id })),
  ).sort((a, b) => b.ts - a.ts);

  const entries = state.invoices.flatMap((i) =>
    i.audit.map((a) => ({ ...a, buyer: i.buyer.name, invoiceId: i.invoice.id })),
  ).sort((a, b) => b.ts - a.ts);

  const byActor: Record<string, number> = {};
  for (const e of entries) byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;

  const totalGuards = entries.reduce((s, e) => s + e.guards.length, 0);
  const failedGuards = entries.reduce((s, e) => s + e.guards.filter((g) => !g.pass).length, 0);

  return (
    <div className="container">
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="h1">Audit trail</h1>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
            Har action, uska reason, aur woh kis event se juda hai.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a className="btn btn-ghost" href="/api/audit?format=csv">CSV</a>
          <a className="btn btn-ghost" href="/api/audit?format=json">JSON</a>
        </div>
      </header>

      <section className="stats" style={{ marginBottom: 20 }}>
        <div className="stat">
          <span className="overline">Recover hua</span>
          <span className="stat-value" style={{ color: "var(--accent-deep)" }}>{formatINRCompact(collected)}</span>
          <span className="stat-sub">{billed ? ((collected / billed) * 100).toFixed(1) : 0}% of {formatINRCompact(billed)}</span>
        </div>
        <div className="stat">
          <span className="overline">Abhi baaki</span>
          <span className="stat-value">{formatINRCompact(outstanding)}</span>
          <span className="stat-sub">{state.invoices.filter((i) => !["paid","closed"].includes(i.invoice.substate)).length} khule</span>
        </div>
        <div className="stat">
          <span className="overline">Payments</span>
          <span className="stat-value">{payments.length}</span>
          <span className="stat-sub">har ek webhook se</span>
        </div>
        <div className="stat">
          <span className="overline">Actions logged</span>
          <span className="stat-value">{entries.length}</span>
          <span className="stat-sub">{Object.entries(byActor).map(([k, n]) => `${n} ${k}`).join(" · ")}</span>
        </div>
        <div className="stat">
          <span className="overline">Guard checks</span>
          <span className="stat-value">{totalGuards}</span>
          <span className="stat-sub" style={failedGuards ? { color: "#b04a28" } : {}}>
            {failedGuards} refuse hue
          </span>
        </div>
      </section>

      <div className="explain" style={{ marginBottom: 20 }}>
        <span className="tag">Ye kyun matter karta hai</span>
        Har rupee jo yahan dikh raha hai woh Razorpay ke webhook se aaya hai —
        koi manual entry nahi. Aur har action ke saath uska reason aur guards ka
        result likha hai. Panel ye poocha to: <strong>ye maine nahi likha, system
        ne likha</strong>.
      </div>

      {payments.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h2 className="h2" style={{ marginBottom: 12 }}>
            Paisa aaya <span style={{ color: "var(--text-4)" }}>· {payments.length}</span>
          </h2>
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
          <p className="explain-inline">
            Har payment ka evidence ek Razorpay event id hai. Wahi id audit entry
            mein bhi hai, to kisi bhi rupee ko wapas trace kiya ja sakta hai.
          </p>
        </section>
      )}

      <section>
        <h2 className="h2" style={{ marginBottom: 12 }}>
          Har action <span style={{ color: "var(--text-4)" }}>· {entries.length}</span>
        </h2>
        <div className="card">
          {entries.slice(0, 80).map((e) => {
            const failed = e.guards.filter((g) => !g.pass);
            return (
              <div key={e.id} style={{ padding: "10px 14px", borderTop: "1px solid var(--hairline)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span className={`chip ${ACTOR_CLS[e.actor] ?? "chip-neutral"}`}>
                    {ACTOR_HI[e.actor] ?? e.actor}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{ACTION_HI[e.action] ?? e.action}</span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{e.buyer}</span>
                  <Link href={`/live/${e.invoiceId}`} className="mono" style={{ color: "var(--text-4)" }}>
                    {e.invoiceId}
                  </Link>
                  <span className="num" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-4)" }}>
                    {formatTs(e.ts)}
                  </span>
                </div>
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
                  {e.rationale}
                </p>
                <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {e.guards.length > 0 && (
                    <span style={{ fontSize: 11, color: failed.length ? "#b04a28" : "var(--accent-deep)" }}>
                      {failed.length === 0
                        ? `✓ ${e.guards.length} guards pass`
                        : `✕ ${failed.map((g) => g.name.replace(/_/g, " ")).join(", ")}`}
                    </span>
                  )}
                  {e.evidence.map((ev) => <span key={ev} className="evidence">{ev}</span>)}
                </div>
              </div>
            );
          })}
        </div>
        {entries.length > 80 && (
          <p className="explain-inline">
            Pehle 80 dikha rahe hain. Poora trail CSV ya JSON mein download karo.
          </p>
        )}
      </section>
    </div>
  );
}
