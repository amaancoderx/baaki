import { addDays, daysBetween, istParts } from "./time.js";
import type { Action, CaseFile, Channel, Persona, Rung } from "./types.js";

/**
 * Days that must pass before the given rung may fire. Silent buyers get a
 * wider gap: if two touches have produced no reply at all, sending a third on
 * the same cadence is spending goodwill for nothing.
 */
export function requiredGap(c: CaseFile, rung: Rung): number {
  const idx = c.policy.ladder.indexOf(rung);
  const base = c.policy.rungGapDays[idx] ?? c.policy.minGapDays;
  const silent = c.touches.length >= c.policy.silentBackoffAfterTouches && c.replies.length === 0;
  const gap = silent ? base * c.policy.silentBackoffMultiplier : base;
  return Math.max(gap, c.policy.minGapDays);
}

/** Days since the last touch, or null when nothing has been sent yet. */
export function daysSinceLastTouch(c: CaseFile): number | null {
  const last = c.touches[c.touches.length - 1];
  if (!last) return null;
  return daysBetween(istParts(last.ts).date, c.today);
}

export interface FastDecision {
  action: Action;
  rationale: string;
}

const channelFor = (rung: Rung): Channel => (rung === "pre_due" ? "whatsapp" : "whatsapp");
const personaFor = (rung: Rung): Persona => (rung === "owner_whatsapp" ? "owner" : "accounts");

/**
 * The fast path is a pure function. Given the same case file it returns the
 * same action, which is what makes the holdout comparison meaningful.
 */
export function fastPath(c: CaseFile, draft: (rung: Rung, persona: Persona) => string): FastDecision {
  const inv = c.invoice;

  if (inv.substate === "paid") {
    return { action: { kind: "stop", reason: "paid" }, rationale: "Invoice is paid in full. Closing the campaign." };
  }
  if (inv.substate === "closed") {
    return { action: { kind: "none", reason: "closed" }, rationale: "Invoice is already closed." };
  }
  if (inv.substate === "human_hold") {
    return { action: { kind: "none", reason: "human_hold" }, rationale: "Waiting on a human. No automated action." };
  }
  if (inv.substate === "disputed") {
    return {
      action: { kind: "none", reason: "disputed" },
      rationale: `Dispute open: ${inv.disputeReason ?? "reason not recorded"}. Outreach stays frozen until a human resolves it.`,
    };
  }

  // Campaign clock has run out.
  if (daysBetween(inv.campaignEndsOn, c.today) > 0) {
    return {
      action: { kind: "escalate_to_human", reason: "campaign ended" },
      rationale: `Campaign ended on ${inv.campaignEndsOn} with ${c.touches.length} touches and no payment. Handing to a human.`,
    };
  }

  // A promise in flight is a reason to do nothing.
  if (inv.substate === "promised" && inv.promisedFor) {
    if (daysBetween(c.today, inv.promisedFor) >= 0) {
      return {
        action: { kind: "schedule_wait", until: addDays(inv.promisedFor, 1), reason: "promise in flight" },
        rationale: `Buyer promised payment by ${inv.promisedFor}. Waiting until the day after before doing anything.`,
      };
    }
  }

  const daysToDue = daysBetween(c.today, inv.dueOn);

  // Not due yet, and not close enough to warrant a pre-due nudge.
  if (daysToDue > c.policy.preDueDays) {
    return {
      action: { kind: "none", reason: "not due" },
      rationale: `Due in ${daysToDue} days. Nothing to do yet.`,
    };
  }

  // Pre-due nudge, once.
  if (daysToDue > 0) {
    const alreadyPreDue = c.touches.some((t) => t.rung === "pre_due");
    if (alreadyPreDue) {
      return { action: { kind: "none", reason: "pre-due nudge already sent" }, rationale: `Pre-due reminder already sent. Due in ${daysToDue} days.` };
    }
    return {
      action: { kind: "send_nudge", channel: "whatsapp", persona: "accounts", rung: "pre_due", draft: draft("pre_due", "accounts") },
      rationale: `Due in ${daysToDue} days. Sending the pre-due reminder while the payment link is still live.`,
    };
  }

  // No reply to anything so far: stop spending touches on a silent buyer.
  if (c.replies.length === 0 && c.touches.length >= c.policy.silentTouchCap) {
    return {
      action: { kind: "escalate_to_human", reason: "silent buyer, touch cap reached" },
      rationale: `${c.touches.length} touches with no reply of any kind. Further automated contact has no evidence behind it; handing to a human.`,
    };
  }

  // Out of ladder.
  if (c.touches.length >= c.policy.maxTouches) {
    return {
      action: { kind: "escalate_to_human", reason: "touch cap reached" },
      rationale: `${c.touches.length} touches sent with no payment. The cap is ${c.policy.maxTouches}; handing to a human.`,
    };
  }

  const rung = c.nextRung;
  if (rung === "human") {
    return {
      action: { kind: "escalate_to_human", reason: "ladder exhausted" },
      rationale: "The ladder is exhausted. Handing to a human.",
    };
  }

  // Hold the rung until its own gap has elapsed. The guards would block an
  // early send anyway, but a policy that proposes actions it knows are barred
  // makes the audit trail unreadable and the blocked-attempt count meaningless.
  const since = daysSinceLastTouch(c);
  const gap = requiredGap(c, rung);
  if (since !== null && since < gap) {
    const silent = c.touches.length >= c.policy.silentBackoffAfterTouches && c.replies.length === 0;
    return {
      action: { kind: "none", reason: "rung gap not elapsed" },
      rationale: silent
        ? `Last touch was ${since} day(s) ago and this buyer has not replied to any of ${c.touches.length} touches. Backing off to a ${gap}-day gap before rung ${rung}.`
        : `Last touch was ${since} day(s) ago. Rung ${rung} needs a ${gap}-day gap.`,
    };
  }

  const persona = personaFor(rung);
  return {
    action: { kind: "send_nudge", channel: channelFor(rung), persona, rung, draft: draft(rung, persona) },
    rationale: `${c.daysOverdue} days overdue, ${since === null ? "no touches yet" : `last touch ${since} days ago`}. Next rung is ${rung}.`,
  };
}
