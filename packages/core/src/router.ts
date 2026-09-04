import { daysBetween } from "./time.js";
import type { CaseFile } from "./types.js";

export type Route = "fast" | "slow";

export interface RouteDecision {
  route: Route;
  /** Named so the README's "~80% deterministic" claim is checkable, not asserted. */
  reason: string;
}

/**
 * Deterministic and small on purpose. The model is expensive and unpredictable;
 * it earns a case only when the case genuinely needs judgment.
 */
export function route(c: CaseFile): RouteDecision {
  const inv = c.invoice;

  if (inv.substate === "paid" || inv.substate === "closed") {
    return { route: "fast", reason: "terminal state" };
  }
  if (inv.substate === "human_hold") {
    return { route: "fast", reason: "already held for a human" };
  }

  // A free-text reply nobody has acted on yet.
  const lastReply = c.replies[c.replies.length - 1];
  const lastTouch = c.touches[c.touches.length - 1];
  if (lastReply && lastReply.source === "free_text" && (!lastTouch || lastReply.ts > lastTouch.ts)) {
    return { route: "slow", reason: "unhandled free-text reply" };
  }

  // Low-confidence parse: the model reads it again with the full case in view.
  if (lastReply && lastReply.confidence < c.policy.minParseConfidence) {
    return { route: "slow", reason: "reply parse below confidence threshold" };
  }

  // A promise that came and went without money.
  if (inv.substate === "promised" && inv.promisedFor) {
    if (daysBetween(inv.promisedFor, c.today) > 0 && inv.amountPaid < inv.amount) {
      return { route: "slow", reason: "promise broken" };
    }
    return { route: "fast", reason: "promise still in flight" };
  }

  // A dispute nobody has resolved.
  if (inv.substate === "disputed") {
    const opened = c.replies.filter((r) => r.intent === "dispute").pop();
    const age = opened ? daysBetween(new Date(opened.ts).toISOString().slice(0, 10), c.today) : 0;
    if (age > c.policy.disputeStaleDays) {
      return { route: "slow", reason: `dispute open ${age} days` };
    }
    return { route: "fast", reason: "dispute recently opened" };
  }

  // Gone quiet well past due, with budget left to spend.
  const silent = c.replies.length === 0;
  if (silent && c.daysOverdue >= c.policy.escalateAfterSilentDays && c.touches.length < c.policy.maxTouches) {
    return { route: "slow", reason: "silent past escalation threshold" };
  }

  // The next rung speaks as the owner, or hands over entirely.
  if (c.nextRung === "owner_whatsapp" || c.nextRung === "human") {
    return { route: "slow", reason: `next rung is ${c.nextRung}` };
  }

  return { route: "fast", reason: "routine" };
}
