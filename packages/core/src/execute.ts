import type { GuardResult } from "./audit.js";
import { runGuards, type Guard } from "./guards/index.js";
import type { Ledger } from "./ledger.js";
import { istParts } from "./time.js";
import type { Action, CaseFile, Decision } from "./types.js";

export interface ExecutionResult {
  applied: boolean;
  action: Action;
  guards: GuardResult[];
  violation: string | null;
}

/**
 * Guards run here, at execution time, not when the action was proposed. A
 * decision made at 17:58 that arrives at 18:01 is outside the window and does
 * not go out, regardless of what the proposer believed.
 */
export function execute(
  ledger: Ledger,
  c: CaseFile,
  decision: Decision,
  nowMs: number,
  guards?: readonly Guard[],
): ExecutionResult {
  const a = decision.action;
  const verdict = runGuards(c, a, nowMs, guards);

  if (!verdict.allowed) {
    // A refused action still settles the question for today. Without recording
    // when to look again, the router has no standing decision and re-escalates
    // the identical case tomorrow — which is most of why the agent was being
    // asked the same thing forty days running.
    if (decision.nextReviewAt) {
      ledger.audit.append({
        ts: nowMs, invoiceId: c.invoice.id, actor: decision.actor, action: "none",
        params: { blocked: a.kind, nextReviewAt: decision.nextReviewAt },
        rationale: `${decision.rationale} Refused by guards: ${verdict.violation}`,
        guards: verdict.results, policyVersion: c.policy.policyVersion,
        evidence: [c.invoice.id],
      });
    }
    return { applied: false, action: a, guards: verdict.results, violation: verdict.violation };
  }

  const today = istParts(nowMs).date;
  // Carried on every audit entry so the router can read the standing decision
  // back after a restart, and so the trail shows when it was meant to expire.
  const review = decision.nextReviewAt ? { nextReviewAt: decision.nextReviewAt } : {};

  switch (a.kind) {
    case "none":
      // A no-op still records when to look again, otherwise the router has no
      // standing decision to honour and re-asks the same question tomorrow.
      if (decision.nextReviewAt) {
        ledger.audit.append({
          ts: nowMs, invoiceId: c.invoice.id, actor: decision.actor, action: "none",
          params: { reason: a.reason, ...review },
          rationale: decision.rationale, guards: verdict.results,
          policyVersion: c.policy.policyVersion, evidence: [c.invoice.id],
        });
      }
      break;

    case "send_nudge": {
      ledger.recordTouch(
        {
          invoiceId: c.invoice.id,
          buyerId: c.buyer.id,
          ts: nowMs,
          channel: a.channel,
          persona: a.persona,
          rung: a.rung,
          carriedLiveLink: ledger.linkIsLive(c.invoice, today),
          body: a.draft,
        },
        verdict.results,
        decision.rationale,
        decision.actor === "webhook" ? "fast" : decision.actor,
        review,
      );
      break;
    }

    case "reissue_payment_path":
      ledger.reissuePaymentPath(
        c.invoice.id, today, 14, decision.rationale,
        decision.actor === "agent" ? "agent" : "fast",
      );
      break;

    case "schedule_wait":
      // Recorded, not enforced by mutation: the ledger substate already carries
      // the promise, and re-deciding tomorrow is cheaper than a scheduler.
      ledger.audit.append({
        ts: nowMs,
        invoiceId: c.invoice.id,
        actor: decision.actor,
        action: "schedule_wait",
        params: { until: a.until, reason: a.reason, ...review },
        rationale: decision.rationale,
        guards: verdict.results,
        policyVersion: c.policy.policyVersion,
        evidence: [c.invoice.id],
      });
      break;

    case "open_dispute":
      ledger.setSubstate(c.invoice.id, "disputed", decision.rationale,
        decision.actor === "agent" ? "agent" : "fast", [c.invoice.id], { disputeReason: a.reason, ...review });
      break;

    case "escalate_to_human":
      ledger.setSubstate(c.invoice.id, "human_hold", decision.rationale,
        decision.actor === "agent" ? "agent" : "fast", [c.invoice.id], review);
      break;

    case "stop":
      ledger.setSubstate(c.invoice.id, "closed", decision.rationale,
        decision.actor === "agent" ? "agent" : "fast", [c.invoice.id],
        { closedOn: today, closedReason: a.reason });
      break;
  }

  return { applied: true, action: a, guards: verdict.results, violation: null };
}
