import type { Channel, Persona as ContactPersona, Rung, Touch } from "@baaki/core";
import { addDays, daysBetween, istParts, type CivilDate } from "@baaki/core";
import { hazardBucket, type Persona, type PersonaFile } from "./personas.js";
import type { Rng } from "./rng.js";

/**
 * Hidden buyer state. Nothing here is ever placed on a CaseFile; the agent
 * sees only the replies and payments this state produces.
 */
export interface BuyerSimState {
  buyerId: string;
  personaKey: string;
  /** Set only by a promise the buyer intends to keep. Forces payment that day. */
  scheduledPayOn: CivilDate | null;
  /**
   * Set by a promise the buyer does *not* intend to keep. Suppresses the
   * hazard while the buyer sits on their own date, then releases. A broken
   * promise must not guarantee payment, or promise_breaker becomes the
   * best-paying persona in the book.
   */
  quietUntil: CivilDate | null;
  promiseWillBeKept: boolean | null;
  promisedOn: CivilDate | null;
  hasDisputed: boolean;
  disputeOpenedOn: CivilDate | null;
  disputeResolvedOn: CivilDate | null;
  hasPaidPartial: boolean;
  complaints: number;
  optedOut: boolean;
  /** Replies the buyer has decided to send but that have not arrived yet. */
  pending: { arriveOn: CivilDate; intent: string; promiseDate?: CivilDate; disputeReason?: string }[];
}

export function newBuyerState(buyerId: string, personaKey: string): BuyerSimState {
  return {
    buyerId, personaKey,
    scheduledPayOn: null, quietUntil: null, promiseWillBeKept: null, promisedOn: null,
    hasDisputed: false, disputeOpenedOn: null, disputeResolvedOn: null,
    hasPaidPartial: false, complaints: 0, optedOut: false, pending: [],
  };
}

/**
 * How much a touch lifts the payment hazard. Penalties scale the *excess* over
 * 1, so a fully-penalised touch is inert rather than harmful, and a nudge with
 * a dead link is worth exactly nothing.
 */
export function touchLift(p: Persona, t: Touch, calendar: string): number {
  let lift = p.touch_lift[t.channel];
  if (t.persona === "owner") lift *= p.touch_lift.owner_persona;

  const scaleExcess = (factor: number) => {
    lift = 1 + (lift - 1) * factor;
  };

  if (!t.carriedLiveLink) scaleExcess(p.dead_link_touch_effect);

  const { hour, weekday, date } = istParts(t.ts);
  const [bestFrom, bestTo] = p.hour_effect.best;
  if (hour < bestFrom || hour >= bestTo) scaleExcess(p.hour_effect.multiplier_off_peak);

  // Reuse the same calendar the guards use, so a touch the guards would have
  // blocked is also the touch the buyer reacts badly to.
  const isSunday = weekday === 0;
  if (isSunday || isHolidayLike(date, calendar)) scaleExcess(p.holiday_touch_penalty);

  return Math.max(1, lift);
}

// Kept local to avoid a cycle back into core's guard module for one predicate.
let holidaySet: ReadonlySet<string> | null = null;
export function setHolidaySet(s: ReadonlySet<string>): void {
  holidaySet = s;
}
function isHolidayLike(date: CivilDate, _calendar: string): boolean {
  return holidaySet?.has(date) ?? false;
}

export interface HazardInput {
  persona: Persona;
  state: BuyerSimState;
  today: CivilDate;
  daysOverdue: number;
  isDue: boolean;
  touches: Touch[];
  meta: PersonaFile["meta"];
  calendar: string;
}

/** Per-day probability that this buyer pays today. */
export function payHazard(inp: HazardInput): number {
  const { persona: p, state, today, daysOverdue, isDue, touches, meta } = inp;

  // A live dispute stops payment dead until the merchant resolves it.
  if (state.disputeOpenedOn && !state.disputeResolvedOn) return 0;
  if (state.disputeResolvedOn && daysBetween(state.disputeResolvedOn, today) >= 0) {
    return p.post_dispute_hazard ?? p.pay_hazard_by_day[hazardBucket(daysOverdue)]!;
  }

  let h = isDue ? p.pay_hazard_by_day[hazardBucket(daysOverdue)]! : p.pre_due_hazard;

  // Sitting on a promise, kept or not: the buyer is waiting for their own date.
  const waitingOn = state.scheduledPayOn ?? state.quietUntil;
  if (waitingOn && daysBetween(today, waitingOn) > 0) {
    h *= 0.15;
  }

  if (state.hasPaidPartial) h *= p.post_partial_hazard_scale ?? 1;

  // The most recent touch inside the lift window is the one that counts.
  const recent = touches.filter(
    (t) => daysBetween(istParts(t.ts).date, today) >= 0 &&
           daysBetween(istParts(t.ts).date, today) <= meta.touch_lift_days,
  );
  if (recent.length > 0) {
    const best = Math.max(...recent.map((t) => touchLift(p, t, inp.calendar)));
    h *= best;
  }

  // Over-contact: too many touches inside the window and the buyer digs in.
  if (overContacted(p, touches, today)) h *= p.over_contact.hazard_penalty;

  return Math.min(0.95, h);
}

export function overContacted(p: Persona, touches: Touch[], today: CivilDate): boolean {
  const inWindow = touches.filter((t) => {
    const d = daysBetween(istParts(t.ts).date, today);
    return d >= 0 && d < p.over_contact.window_days;
  });
  return inWindow.length > p.over_contact.max_touches;
}

export interface ReplyDraw {
  intent: "promise" | "dispute" | "will_pay" | "already_paid" | "partial" | "stop" | "unclear";
  promiseDate?: CivilDate;
  disputeReason?: string;
}

const DISPUTE_REASONS = [
  "80 units hi aaye the, bill 100 ka hai",
  "rate galat lagaya hai, humara PO alag tha",
  "goods damaged the, replacement pending hai",
  "GST number wrong on the invoice",
  "we already raised a debit note for this",
];

/** What the buyer replies, given that they are replying at all. */
export function drawReply(
  p: Persona,
  state: BuyerSimState,
  rng: Rng,
  today: CivilDate,
  isFirstTouch: boolean,
): ReplyDraw {
  if (isFirstTouch && !state.hasDisputed && rng.bool(p.dispute_prob_first_touch)) {
    return { intent: "dispute", disputeReason: rng.pick(DISPUTE_REASONS) };
  }
  if (rng.bool(p.promise_prob_given_reply)) {
    return { intent: "promise", promiseDate: addDays(today, rng.int(2, 8)) };
  }
  if (state.hasPaidPartial && rng.bool(0.3)) return { intent: "partial" };
  return rng.bool(0.5) ? { intent: "will_pay" } : { intent: "unclear" };
}

export function replyDelay(meta: PersonaFile["meta"], rng: Rng): number {
  return rng.pick(meta.reply_delay_days);
}

export type { Channel, ContactPersona, Rung };
