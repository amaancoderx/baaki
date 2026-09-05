"use client";

import { useState } from "react";
import { API, type TickAction, type TickReport } from "@/lib/api";

const ACTION_LABEL: Record<string, string> = {
  send_nudge: "Sent a message",
  reissue_payment_path: "Issued a new payment link",
  schedule_wait: "Waiting",
  open_dispute: "Opened a dispute",
  escalate_to_human: "Handed to a person",
  stop: "Closed the case",
  none: "No action needed",
};

/** Why the router sent this case where it did, in plain terms. */
const ROUTE_LABEL: Record<string, string> = {
  "routine": "nothing unusual",
  "standing decision holds": "already decided, nothing new since",
  "promise still in flight": "waiting on a promise",
  "not due": "not due yet",
  "terminal state": "already settled",
  "unhandled free-text reply": "buyer wrote something that needs reading",
  "silent past escalation threshold": "silent for a long time",
  "promise broken": "promised date passed without payment",
  "next rung is owner_whatsapp": "escalating to the owner's name",
  "next rung is human": "ladder is exhausted",
  "dispute recently opened": "dispute just opened",
  "already held for a human": "a person owns this case",
  "reply parse below confidence threshold": "the reply was not understood clearly",
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
          {a.blocked ? "Blocked" : ACTION_LABEL[a.action.kind] ?? a.action.kind}
        </span>
        <span className="why" style={{ display: "block" }}>
          {a.blocked
            ? `Refused by ${failed.map((g) => g.name.replace(/_/g, " ")).join(", ")}`
            : a.rationale}
        </span>
        <span className="why" style={{ display: "block", color: "var(--text-4)" }}>
          router: {ROUTE_LABEL[a.routeReason] ?? a.routeReason}
          {a.sent && ` · ${a.sent.dryRun ? "dry run" : "delivered on WhatsApp"}${a.sent.template ? ` (${a.sent.template})` : " (free-form)"}`}
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
        <span className="tag">What happens when you run this</span>
        The agent looks at every open invoice and takes <strong>exactly one action</strong>{" "}
        on each. Most are settled by a rule — not due yet, or a promise is in flight.
        Cases that need judgement — the buyer wrote something, a promise was broken,
        someone has gone quiet — go to Gemini. Every action passes through the guards
        before anything is sent, and the reason is written to the audit log.
      </div>

      <div>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? <><span className="spinner" /> Running…</> : "Run the agent"}
        </button>
      </div>

      {error && (
        <div className="explain" style={{ background: "rgba(217,119,87,0.12)", borderColor: "rgba(217,119,87,0.3)" }}>
          <strong>Could not run:</strong> {error}
          <div className="explain-inline">The API may not be reachable.</div>
        </div>
      )}

      {report && (
        <>
          <section className="stats">
            <div className="stat">
              <span className="overline">Considered</span>
              <span className="stat-value">{report.considered}</span>
              <span className="stat-sub">open invoices</span>
            </div>
            <div className="stat">
              <span className="overline">By rule</span>
              <span className="stat-value">{report.fastCount}</span>
              <span className="stat-sub">no model needed</span>
            </div>
            <div className="stat">
              <span className="overline">By agent</span>
              <span className="stat-value" style={{ color: "var(--accent-deep)" }}>{report.slowCount}</span>
              <span className="stat-sub">Gemini decided</span>
            </div>
            <div className="stat">
              <span className="overline">Sent</span>
              <span className="stat-value">{report.sentCount}</span>
              <span className="stat-sub">WhatsApp messages</span>
            </div>
            <div className="stat">
              <span className="overline">Blocked</span>
              <span className="stat-value">{report.blockedCount}</span>
              <span className="stat-sub">refused by guards</span>
            </div>
          </section>

          <div className="card">
            {report.actions.length === 0
              ? <p style={{ padding: 16, fontSize: 13, color: "var(--text-3)" }}>No open invoices. Create one first.</p>
              : report.actions.map((a) => <Row key={a.invoiceId + a.action.kind} a={a} />)}
          </div>

          <p className="explain-inline">
            The full audit trail — every action, its reason, and which guards passed — is available as <a href={`${API}/api/audit?format=csv`} style={{ color: "var(--accent-deep)" }}>CSV</a> or 
            <a href={`${API}/api/audit?format=json`} style={{ color: "var(--accent-deep)" }}>JSON</a> .
          </p>
        </>
      )}
    </div>
  );
}
