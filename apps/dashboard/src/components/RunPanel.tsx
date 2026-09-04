"use client";

import { useState } from "react";
import { API, type TickAction, type TickReport } from "@/lib/api";

const ACTION_HI: Record<string, string> = {
  send_nudge: "Message bheja",
  reissue_payment_path: "Naya payment link banaya",
  schedule_wait: "Wait kar raha hai",
  open_dispute: "Dispute khola",
  escalate_to_human: "Insaan ko de diya",
  stop: "Band kar diya",
  none: "Kuch nahi karna",
};

const ROUTE_HI: Record<string, string> = {
  "routine": "seedha rule",
  "promise still in flight": "promise chal raha hai",
  "not due": "abhi due nahi",
  "terminal state": "case khatam",
  "unhandled free-text reply": "buyer ne likha, padhna padega",
  "silent past escalation threshold": "bahut din se chup hai",
  "promise broken": "promise toota",
  "next rung is owner_whatsapp": "ab owner ke naam se",
  "next rung is human": "ab insaan ka kaam",
  "dispute recently opened": "dispute abhi khula hai",
  "already held for a human": "insaan ke paas hai",
  "reply parse below confidence threshold": "reply samajh nahi aaya",
};

function Row({ a }: { a: TickAction }) {
  const failed = a.guards.filter((g) => !g.pass);
  return (
    <div className="runline">
      <span>
        {a.route === "slow"
          ? <span className="chip chip-accent">agent</span>
          : <span className="chip chip-neutral">rule</span>}
      </span>
      <span className="who">{a.buyer}</span>
      <span>
        <span style={{ fontWeight: 500 }}>
          {a.blocked ? "Roka gaya" : ACTION_HI[a.action.kind] ?? a.action.kind}
        </span>
        <span className="why" style={{ display: "block" }}>
          {a.blocked
            ? `Guard ne mana kiya — ${failed.map((g) => g.name.replace(/_/g, " ")).join(", ")}`
            : a.rationale}
        </span>
        <span className="why" style={{ display: "block", color: "var(--text-4)" }}>
          router: {ROUTE_HI[a.routeReason] ?? a.routeReason}
          {a.sent && ` · ${a.sent.dryRun ? "dry run" : "WhatsApp bheja"}${a.sent.template ? ` (${a.sent.template})` : " (free-form)"}`}
          {a.error && ` · error: ${a.error}`}
        </span>
      </span>
      <span className="mono" style={{ color: "var(--text-4)", fontSize: 11 }}>{a.invoiceId}</span>
    </div>
  );
}

export function RunPanel() {
  const [report, setReport] = useState<TickReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API}/api/tick`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setReport(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="explain">
        <span className="tag">Agent run</span>
        Ek baar chalane pe agent har khule invoice ko dekhega aur{" "}
        <strong>ek hi action</strong> lega. Zyada tar cases pe rule kaafi hai
        (due nahi hua, promise chal raha hai). Jahan sochna padta hai — buyer ne
        kuch likha, promise toota, bahut din se chup hai — wahan Gemini case
        agent decide karta hai. Har action guards se guzarta hai, aur reason
        audit log mein likha jaata hai.
      </div>

      <div>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? <><span className="spinner" /> Agent chal raha hai…</> : "Agent chalao"}
        </button>
      </div>

      {error && (
        <div className="explain" style={{ background: "rgba(217,119,87,0.12)", borderColor: "rgba(217,119,87,0.3)" }}>
          <strong>Nahi chala:</strong> {error}
          <div className="explain-inline">Webhook service band ho sakta hai. <code className="mono">pnpm webhook</code> chalao.</div>
        </div>
      )}

      {report && (
        <>
          <section className="stats">
            <div className="stat">
              <span className="overline">Dekhe</span>
              <span className="stat-value">{report.considered}</span>
              <span className="stat-sub">khule invoice</span>
            </div>
            <div className="stat">
              <span className="overline">Rule se</span>
              <span className="stat-value">{report.fastCount}</span>
              <span className="stat-sub">bina model ke</span>
            </div>
            <div className="stat">
              <span className="overline">Agent se</span>
              <span className="stat-value" style={{ color: "var(--accent-deep)" }}>{report.slowCount}</span>
              <span className="stat-sub">Gemini ne socha</span>
            </div>
            <div className="stat">
              <span className="overline">Bheje</span>
              <span className="stat-value">{report.sentCount}</span>
              <span className="stat-sub">WhatsApp message</span>
            </div>
            <div className="stat">
              <span className="overline">Roke</span>
              <span className="stat-value">{report.blockedCount}</span>
              <span className="stat-sub">guards ne mana kiya</span>
            </div>
          </section>

          <div className="card">
            {report.actions.length === 0
              ? <p style={{ padding: 16, fontSize: 13, color: "var(--text-3)" }}>Koi khula invoice nahi hai. Pehle ek invoice banao.</p>
              : report.actions.map((a) => <Row key={a.invoiceId + a.action.kind} a={a} />)}
          </div>

          <p className="explain-inline">
            Poora audit trail — har action, uska reason, aur kaunse guards pass
            hue — <a href={`${API}/api/audit?format=csv`} style={{ color: "var(--accent-deep)" }}>CSV</a> ya{" "}
            <a href={`${API}/api/audit?format=json`} style={{ color: "var(--accent-deep)" }}>JSON</a> mein download kar sakte ho.
          </p>
        </>
      )}
    </div>
  );
}
