import { addDays, daysBetween, istParts } from "./time.js";
import type { CivilDate } from "./time.js";
import type { Action, CaseFile, Channel, Persona, Policy, Rung } from "./types.js";

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

/**
 * Days from the due date to the last outreach rung. Negative means it fires
 * before the invoice is even due.
 *
 * A ladder whose last rung falls outside the campaign window is not a cautious
 * ladder, it is a rung of dead code: the policy claims an escalation it will
 * never perform, and the message with the most record value never goes out.
 * This shipped: `campaignDays` was 30 against gaps needing 31 days for a
 * replying buyer and 55 for a silent one, so the final notice never fired.
 */
export function daysToLastRung(p: Policy, opts: { silent: boolean } = { silent: true }): number {
  const idx = p.ladder.length - 2;
  let day = -p.preDueDays;
  for (let i = 1; i <= idx; i++) {
    const base = p.rungGapDays[i] ?? p.minGapDays;
    // The buyer who never replies earns the widened gaps, and that buyer is
    // precisely the one the final notice exists for.
    const gap = opts.silent && i >= p.silentBackoffAfterTouches ? base * p.silentBackoffMultiplier : base;
    day += Math.max(gap, p.minGapDays);
  }
  return day;
}

/** Null when the ladder fits inside the campaign, otherwise why it does not. */
export function ladderProblem(p: Policy): string | null {
  const silent = daysToLastRung(p, { silent: true });
  const replying = daysToLastRung(p, { silent: false });
  const last = p.ladder[p.ladder.length - 2];
  if (replying > p.campaignDays) {
    return `The last rung (${last}) needs ${replying} days after the due date and the campaign ends at ${p.campaignDays}. It can never fire.`;
  }
  if (silent > p.campaignDays) {
    return `The last rung (${last}) needs ${silent} days after the due date for a buyer who never replies, and the campaign ends at ${p.campaignDays}. It fires only for buyers who reply, which is the opposite of who it is for.`;
  }
  if (p.maxTouches < p.ladder.length - 1) {
    return `The touch budget is ${p.maxTouches} but the ladder has ${p.ladder.length - 1} sending rungs, so the last one cannot be paid for.`;
  }
  return null;
}

/**
 * Whether to pick up the phone, as a rule rather than a judgement.
 *
 * Evaluated before routing, not inside the fast path alone. The condition for
 * calling is that a buyer has gone quiet, and a quiet case is precisely what
 * the router hands to the agent, so leaving this on the fast path meant the
 * phone could never ring on the cases it exists for.
 *
 * Kept deterministic on purpose. A call is the most intrusive and least
 * reviewable thing this system does, and a rule that fires it is auditable in a
 * way that a model choosing to is not.
 */
export function voiceCall(c: CaseFile): FastDecision | null {
  const inv = c.invoice;
  const voice = c.policy.voice;
  if (!voice?.enabled) return null;
  if (c.callsPlaced >= voice.maxCalls) return null;
  if (c.touches.length === 0) return null;
  if (["paid", "closed", "disputed"].includes(inv.substate)) return null;
  if (c.memory.doNotContact) return null;
  if (daysBetween(inv.campaignEndsOn, c.today) > 0) return null;

  const silent = c.replies.length === 0 && c.daysOverdue >= voice.afterSilentDays;
  const brokenPromise = voice.onBrokenPromise
    && inv.promisedFor !== null
    && daysBetween(inv.promisedFor, c.today) > 0
    && !c.replies.some((r) => r.ts > Date.parse(`${inv.promisedFor}T00:00:00+05:30`));

  if (!silent && !brokenPromise) return null;

  return {
    action: { kind: "place_call", reason: silent ? "silent buyer" : "promise passed with no word" },
    rationale: silent
      ? `${c.touches.length} messages and ${c.daysOverdue} days overdue with no reply of any kind. Messages have stopped telling us anything, so calling to find out why.`
      : `Promised ${inv.promisedFor}, which has passed with no payment and nothing said since. Calling to find out what changed.`,
    nextReviewAt: addDays(c.today, 2),
  };
}

export interface FastDecision {
  action: Action;
  rationale: string;
  /** When to reconsider. The router holds the decision until then. */
  nextReviewAt?: CivilDate;
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
    return { action: { kind: "stop", reason: "paid" }, rationale: "Invoice is paid in full. Closing the campaign.", nextReviewAt: inv.campaignEndsOn };
  }
  if (inv.substate === "closed") {
    return { action: { kind: "none", reason: "closed" }, rationale: "Invoice is already closed.", nextReviewAt: inv.campaignEndsOn };
  }
  if (inv.substate === "human_hold") {
    return { action: { kind: "none", reason: "human_hold" }, rationale: "Waiting on a human. No automated action.", nextReviewAt: inv.campaignEndsOn };
  }
  if (inv.substate === "disputed") {
    return {
      action: { kind: "none", reason: "disputed" },
      rationale: `Dispute open: ${inv.disputeReason ?? "reason not recorded"}. Outreach stays frozen until a human resolves it.`,
      nextReviewAt: addDays(c.today, c.policy.disputeStaleDays),
    };
  }

  // Campaign clock has run out.
  if (daysBetween(inv.campaignEndsOn, c.today) > 0) {
    return {
      action: { kind: "escalate_to_human", reason: "campaign ended" },
      rationale: `Campaign ended on ${inv.campaignEndsOn} with ${c.touches.length} touches and no payment. Handing to a human.`,
      nextReviewAt: addDays(c.today, 365),
    };
  }

  // A promise in flight is a reason to do nothing.
  if (inv.substate === "promised" && inv.promisedFor) {
    if (daysBetween(c.today, inv.promisedFor) >= 0) {
      return {
        action: { kind: "schedule_wait", until: addDays(inv.promisedFor, 1), reason: "promise in flight" },
        rationale: `Buyer promised payment by ${inv.promisedFor}. Waiting until the day after before doing anything.`,
        nextReviewAt: addDays(inv.promisedFor, 1),
      };
    }
  }

  const daysToDue = daysBetween(c.today, inv.dueOn);

  // Not due yet, and not close enough to warrant a pre-due nudge.
  if (daysToDue > c.policy.preDueDays) {
    return {
      action: { kind: "none", reason: "not due" },
      rationale: `Due in ${daysToDue} days. Nothing to do yet.`,
      nextReviewAt: addDays(inv.dueOn, -c.policy.preDueDays),
    };
  }

  // Pre-due nudge, once.
  if (daysToDue > 0) {
    const alreadyPreDue = c.touches.some((t) => t.rung === "pre_due");
    if (alreadyPreDue) {
      return {
        action: { kind: "none", reason: "pre-due nudge already sent" },
        rationale: `Pre-due reminder already sent. Due in ${daysToDue} days.`,
        nextReviewAt: inv.dueOn,
      };
    }
    return {
      action: { kind: "send_nudge", channel: "whatsapp", persona: "accounts", rung: "pre_due", draft: draft("pre_due", "accounts") },
      rationale: `Due in ${daysToDue} days. Sending the pre-due reminder while the payment link is still live.`,
      nextReviewAt: inv.dueOn,
    };
  }

  const callNow = voiceCall(c);
  if (callNow) return callNow;

  // No reply to anything so far: stop spending touches on a silent buyer.
  if (c.replies.length === 0 && c.touches.length >= c.policy.silentTouchCap) {
    return {
      action: { kind: "escalate_to_human", reason: "silent buyer, touch cap reached" },
      rationale: `${c.touches.length} touches with no reply of any kind. Further automated contact has no evidence behind it; handing to a human.`,
      nextReviewAt: addDays(c.today, 365),
    };
  }

  // Out of ladder.
  if (c.touches.length >= c.policy.maxTouches) {
    return {
      action: { kind: "escalate_to_human", reason: "touch cap reached" },
      rationale: `${c.touches.length} touches sent with no payment. The cap is ${c.policy.maxTouches}; handing to a human.`,
      nextReviewAt: addDays(c.today, 365),
    };
  }

  const rung = c.nextRung;
  if (rung === "human") {
    return {
      action: { kind: "escalate_to_human", reason: "ladder exhausted" },
      rationale: "The ladder is exhausted. Handing to a human.",
      nextReviewAt: addDays(c.today, 365),
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
      nextReviewAt: addDays(c.today, Math.max(1, gap - since)),
    };
  }

  const persona = personaFor(rung);
  return {
    action: { kind: "send_nudge", channel: channelFor(rung), persona, rung, draft: draft(rung, persona) },
    rationale: `${c.daysOverdue} days overdue, ${since === null ? "no touches yet" : `last touch ${since} days ago`}. Next rung is ${rung}.`,
    // After sending, the next rung's own gap governs when to look again.
    nextReviewAt: addDays(c.today, requiredGap(c, c.policy.ladder[Math.min(c.policy.ladder.indexOf(rung) + 1, c.policy.ladder.length - 1)]!)),
  };
}
