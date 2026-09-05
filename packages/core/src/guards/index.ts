import type { GuardResult } from "../audit.js";
import { daysBetween, istParts, parseHHMM, type CivilDate } from "../time.js";
import type { Action, CaseFile } from "../types.js";
import { isNonBusinessDay } from "./holidays.js";

export { isHoliday, isNonBusinessDay, holidayCalendars } from "./holidays.js";

/** Phrases that carry legal weight or menace. Blocked before the final rung. */
export const FORBIDDEN_PHRASES: readonly string[] = [
  "legal action", "lawyer", "court", "police", "fir", "arrest",
  "blacklist", "defaulter list", "recovery agent", "consequences will",
  "we will not hesitate", "criminal", "section 138", "cheque bounce case",
  "last warning", "final warning", "seize", "damages",
];

/** A guard is a pure function of the case and the proposed action. */
export type Guard = (c: CaseFile, a: Action, nowMs: number) => GuardResult;

const pass = (name: string): GuardResult => ({ name, pass: true });
const fail = (name: string, detail: string): GuardResult => ({ name, pass: false, detail });

/** Only outbound contact is gated. Waiting, escalating and stopping are always allowed. */
const isOutbound = (a: Action): boolean => a.kind === "send_nudge";

/**
 * Anything the buyer actually receives. Wider than `isOutbound`, because
 * delivering an invoice and calling someone are not nudges but do reach a
 * person, and "do not contact me" means all of it.
 */
const reachesBuyer = (a: Action): boolean =>
  a.kind === "send_nudge" || a.kind === "deliver_invoice" || a.kind === "place_call";

export const stopOnPaid: Guard = (c, a) => {
  const n = "stop_on_paid";
  if (a.kind === "stop" || a.kind === "none") return pass(n);
  if (c.invoice.substate === "paid" || c.invoice.substate === "closed") {
    return fail(n, `Invoice ${c.invoice.id} is ${c.invoice.substate}. No further action is permitted.`);
  }
  return pass(n);
};

export const doNotContact: Guard = (c, a) => {
  const n = "do_not_contact";
  if (!reachesBuyer(a)) return pass(n);
  if (c.memory.doNotContact) {
    return fail(n, `Buyer ${c.buyer.id} is on do_not_contact. This is permanent and cannot be overridden.`);
  }
  return pass(n);
};

/**
 * Refuses to contact a buyer nobody is holding.
 *
 * Sample and seeded buyers carry invented numbers. Without this the ladder
 * happily messages them and, once voice is on, dials them: a real Twilio call
 * to a number that was never real. Absent means reachable, so existing buyers
 * are unaffected and only data that says it is fake is treated as fake.
 */
export const reachableBuyer: Guard = (c, a) => {
  const n = "reachable_buyer";
  if (!reachesBuyer(a)) return pass(n);
  if (c.buyer.reachable === false) {
    return fail(n, `Buyer ${c.buyer.id} is marked unreachable: this number is sample data, not a line someone answers.`);
  }
  return pass(n);
};

export const contactWindow: Guard = (c, a, nowMs) => {
  const n = "contact_window";
  if (!isOutbound(a)) return pass(n);
  const { hour, minute, date, weekday } = istParts(nowMs);
  const start = parseHHMM(c.policy.contactWindow.start);
  const end = parseHHMM(c.policy.contactWindow.end);
  const mins = hour * 60 + minute;
  if (mins < start.hour * 60 + start.minute || mins >= end.hour * 60 + end.minute) {
    return fail(n, `Local time ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} IST is outside the contact window ${c.policy.contactWindow.start}-${c.policy.contactWindow.end}.`);
  }
  if (isNonBusinessDay(date, c.policy.contactWindow.holidays, weekday)) {
    return fail(n, `${date} is a holiday or Sunday in calendar ${c.policy.contactWindow.holidays}.`);
  }
  return pass(n);
};

export const maxTouches: Guard = (c, a) => {
  const n = "max_touches";
  if (!isOutbound(a)) return pass(n);
  if (c.touches.length >= c.policy.maxTouches) {
    return fail(n, `Invoice already has ${c.touches.length} touches; the cap is ${c.policy.maxTouches}.`);
  }
  return pass(n);
};

export const minGap: Guard = (c, a, nowMs) => {
  const n = "min_gap_days";
  if (!isOutbound(a)) return pass(n);
  const last = c.touches[c.touches.length - 1];
  if (!last) return pass(n);
  const gap = daysBetween(istParts(last.ts).date, istParts(nowMs).date);
  if (gap < c.policy.minGapDays) {
    return fail(n, `Last touch was ${gap} day(s) ago; the minimum gap is ${c.policy.minGapDays}.`);
  }
  return pass(n);
};

export const noContactWhileHeld: Guard = (c, a, nowMs) => {
  const n = "no_contact_while_held";
  if (!isOutbound(a)) return pass(n);
  const today: CivilDate = istParts(nowMs).date;
  const s = c.invoice.substate;

  if (s === "disputed") {
    return fail(n, `Invoice is disputed (${c.invoice.disputeReason ?? "no reason recorded"}). Outreach is frozen until a human resolves it.`);
  }
  if (s === "human_hold") {
    return fail(n, "Invoice is on human_hold. Outreach is frozen.");
  }
  if (s === "promised" && c.invoice.promisedFor) {
    // Frozen through the promised date; the day after is fair game.
    if (daysBetween(today, c.invoice.promisedFor) >= 0) {
      return fail(n, `Buyer promised payment by ${c.invoice.promisedFor}; contact is frozen until the day after that date.`);
    }
  }
  return pass(n);
};

export const whatsappSessionWindow: Guard = (c, a, nowMs) => {
  const n = "whatsapp_24h_window";
  if (a.kind !== "send_nudge" || a.channel !== "whatsapp") return pass(n);
  // Free-form is only legal inside 24h of the buyer's last inbound message.
  // Everything the ladder sends is a template, so this guard fails only when
  // a caller marks a draft as free-form outside the window.
  const lastInbound = c.replies[c.replies.length - 1];
  const withinSession = lastInbound ? nowMs - lastInbound.ts <= 24 * 3600_000 : false;
  const isFreeForm = a.draft.startsWith("[free_form]");
  if (isFreeForm && !withinSession) {
    return fail(n, "Free-form WhatsApp is only permitted inside the 24-hour session window. Use an approved template.");
  }
  return pass(n);
};

/**
 * A call is held to a narrower window than a message. Nine in the evening is
 * a rude WhatsApp and an unacceptable phone call, so voice does not inherit
 * the message window.
 */
export const voiceWindow: Guard = (c, a, nowMs) => {
  const n = "voice_window";
  if (a.kind !== "place_call") return pass(n);
  const v = c.policy.voice;
  if (!v) return fail(n, "Voice is not configured in this policy.");
  const { hour, minute, date, weekday } = istParts(nowMs);
  const start = parseHHMM(v.window.start);
  const end = parseHHMM(v.window.end);
  const mins = hour * 60 + minute;
  if (mins < start.hour * 60 + start.minute || mins >= end.hour * 60 + end.minute) {
    return fail(n, `Local time ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} IST is outside the calling window ${v.window.start}-${v.window.end}.`);
  }
  if (isNonBusinessDay(date, c.policy.contactWindow.holidays, weekday)) {
    return fail(n, `${date} is a holiday or Sunday. Calls are not placed on non-business days.`);
  }
  return pass(n);
};

/**
 * One call per invoice, for its whole life. A second unanswered call tells you
 * nothing the first did not, and a buyer who is being rung repeatedly stops
 * answering the number.
 */
export const voiceBudget: Guard = (c, a) => {
  const n = "voice_budget";
  if (a.kind !== "place_call") return pass(n);
  const v = c.policy.voice;
  if (!v?.enabled) return fail(n, "Voice is disabled in this policy.");
  if (c.callsPlaced >= v.maxCalls) {
    return fail(n, `${c.callsPlaced} call(s) already placed on this invoice; the lifetime cap is ${v.maxCalls}.`);
  }
  if (c.invoice.substate === "disputed") {
    return fail(n, "Invoice is disputed. A dispute is resolved by a person, not by calling the buyer about it.");
  }
  return pass(n);
};

export const campaignEnd: Guard = (c, a, nowMs) => {
  const n = "campaign_end";
  const today = istParts(nowMs).date;
  const past = daysBetween(c.invoice.campaignEndsOn, today) > 0;
  if (!past) return pass(n);
  if (a.kind === "escalate_to_human" || a.kind === "stop" || a.kind === "none") return pass(n);
  return fail(n, `Campaign ended on ${c.invoice.campaignEndsOn}. The only permitted actions are escalate_to_human or stop.`);
};

export const draftFilter: Guard = (c, a) => {
  const n = "draft_filter";
  if (a.kind !== "send_nudge") return pass(n);
  const finalRung = c.policy.ladder[c.policy.ladder.length - 1];
  if (a.rung === finalRung) return pass(n);
  const lower = a.draft.toLowerCase();
  const hit = FORBIDDEN_PHRASES.find((p) => lower.includes(p));
  if (hit) {
    return fail(n, `Draft contains the forbidden phrase "${hit}". Legal or threatening language is not permitted before the final rung.`);
  }
  return pass(n);
};

export const ALL_GUARDS: readonly Guard[] = [
  stopOnPaid,
  doNotContact,
  reachableBuyer,
  campaignEnd,
  noContactWhileHeld,
  voiceWindow,
  voiceBudget,
  contactWindow,
  maxTouches,
  minGap,
  whatsappSessionWindow,
  draftFilter,
];

export interface GuardVerdict {
  allowed: boolean;
  results: GuardResult[];
  /** Concatenated failure detail, handed back to the agent for its one retry. */
  violation: string | null;
}

/**
 * Run every guard, always. Short-circuiting would leave the audit trail with
 * a partial picture, and the whole point of the log is that it is complete.
 */
export function runGuards(c: CaseFile, a: Action, nowMs: number, guards: readonly Guard[] = ALL_GUARDS): GuardVerdict {
  const results = guards.map((g) => g(c, a, nowMs));
  const failures = results.filter((r) => !r.pass);
  return {
    allowed: failures.length === 0,
    results,
    violation: failures.length === 0 ? null : failures.map((f) => `${f.name}: ${f.detail}`).join(" "),
  };
}
