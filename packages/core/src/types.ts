import type { Paise } from "./money.js";
import type { CivilDate } from "./time.js";

export type Channel = "whatsapp" | "email";
export type Persona = "accounts" | "owner";

/** Ladder rungs, in order. The last rung is terminal and hands to a human. */
export const LADDER = ["pre_due", "whatsapp", "whatsapp+reissue", "owner_whatsapp", "human"] as const;
export type Rung = (typeof LADDER)[number];

export type InvoiceState = "open" | "due" | "overdue";
export type Substate =
  | "awaiting_reply"
  | "promised"
  | "disputed"
  | "human_hold"
  | "paid"
  | "closed";

export type ReplyIntent =
  | "will_pay"
  | "promise"
  | "dispute"
  | "already_paid"
  | "partial"
  | "stop"
  | "unclear";

export interface Reply {
  id: string;
  invoiceId: string;
  buyerId: string;
  ts: number;
  channel: Channel;
  /** Button payloads bypass the model entirely. */
  source: "button" | "free_text";
  text: string;
  intent: ReplyIntent;
  promiseDate?: CivilDate;
  disputeReason?: string;
  /** Parse confidence. Buttons are 1. Below policy threshold routes to a human. */
  confidence: number;
}

export interface Touch {
  id: string;
  invoiceId: string;
  buyerId: string;
  ts: number;
  channel: Channel;
  persona: Persona;
  rung: Rung;
  /** False when the payment link was expired at send time: a nudge with no live path. */
  carriedLiveLink: boolean;
  /** Set when the same touch also went out by email. */
  emailed?: boolean;
  /** Set when Razorpay also sent its SMS for this touch. */
  smsed?: boolean;
  body: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  ts: number;
  amount: Paise;
  /** Razorpay event that evidenced it. */
  evidence: string;
}

export interface BuyerMemory {
  buyerId: string;
  avgDaysLate: number;
  promiseKeptRate: number;   // 0..1, 1 when no promises yet made
  disputeRate: number;       // 0..1
  repliesPerTouch: Record<Channel, number>;
  lastReplyHour: number | null;
  language: "en" | "hi" | "hinglish";
  doNotContact: boolean;
  /** Denominators, so the rates above are auditable rather than asserted. */
  counts: {
    invoices: number;
    promisesMade: number;
    promisesKept: number;
    disputesRaised: number;
    touches: Record<Channel, number>;
    replies: Record<Channel, number>;
  };
}

export interface Buyer {
  id: string;
  name: string;
  phone: string;
  /** Where Razorpay sends the link. Absent for buyers who gave only a number. */
  email?: string;
  /**
   * False when nobody is holding this number: seeded buyers, sample data, a
   * contact imported without verification. Outreach is refused rather than
   * attempted, because a message to a number that does not exist is merely
   * wasted and a phone call to one is wasted money.
   */
  reachable?: boolean;
  /** Set only by the sim. The agent never reads this. */
  hiddenPersonaKey?: string;
}

export interface Invoice {
  id: string;
  buyerId: string;
  amount: Paise;
  amountPaid: Paise;
  issuedOn: CivilDate;
  dueOn: CivilDate;
  /** Razorpay `expire_by` on the current payment path. */
  linkExpiresOn: CivilDate | null;
  state: InvoiceState;
  substate: Substate;
  promisedFor: CivilDate | null;
  disputeReason: string | null;
  /** Set once the campaign clock starts, i.e. the due date. */
  campaignEndsOn: CivilDate;
  /** Holdout arm assignment. Baseline invoices get fixed reminders only. */
  arm: "baaki" | "baseline";
  closedOn: CivilDate | null;
  closedReason: string | null;
}

/** Everything the decider is allowed to see. Persona parameters are absent by construction. */
export interface CaseFile {
  today: CivilDate;
  nowMs: number;
  invoice: Invoice;
  buyer: Buyer;
  memory: BuyerMemory;
  touches: Touch[];
  replies: Reply[];
  payments: Payment[];
  daysOverdue: number;
  nextRung: Rung;
  /**
   * Calls already placed on this invoice. Read from the audit log rather than
   * from `touches`, because a call is not a message: the ladder maths and the
   * over-contact model are calibrated on messages, and folding a call into
   * them would change what every published number means.
   */
  callsPlaced: number;
  /** When the last call went out, so a second one cannot follow it straight away. */
  lastCallAt: number | null;
  /**
   * When a decider last acted on this invoice. A reply is "handled" once a
   * decision postdates it, even a decision that sends nothing. Otherwise a
   * case answered with schedule_wait re-escalates to the agent every single
   * day for the life of the promise.
   */
  lastDecisionTs: number | null;
  /** The standing decision: hold until this date unless something new arrives. */
  nextReviewOn: CivilDate | null;
  /**
   * What the rules would do with this case, given to the agent as its default.
   *
   * Without it the two are not comparable: the rules were tuned against these
   * buyers by ablation and the agent was not, so the agent starts from a worse
   * prior and its caution reads as a deficiency. Given the proposal, the
   * question becomes the useful one: does the case contain information the
   * rules cannot use?
   */
  rulesProposal?: { action: string; reason: string };
  policy: Policy;
}

// ---------------------------------------------------------------------------
// Actions: the six write tools, plus the explicit no-op.
// ---------------------------------------------------------------------------

export type Action =
  | { kind: "none"; reason: string }
  /**
   * Handing the buyer the bill, on every channel at once. Deliberately not a
   * nudge: a buyer is not annoyed by receiving the invoice they expected, so
   * this does not spend the touch budget and does not enter the over-contact
   * model. It fires once, at creation.
   */
  | { kind: "deliver_invoice"; channels: Channel[] }
  /**
   * A real phone call. Not a ladder rung, because it is not the next thing to
   * try after a message: it is what happens when messages have stopped
   * returning information. Off in the simulator, which does not model calls.
   */
  | { kind: "place_call"; reason: string }
  | { kind: "send_nudge"; channel: Channel; persona: Persona; rung: Rung; draft: string }
  | { kind: "reissue_payment_path" }
  | { kind: "schedule_wait"; until: CivilDate; reason: string }
  | { kind: "open_dispute"; reason: string }
  | { kind: "escalate_to_human"; reason: string }
  | { kind: "stop"; reason: string };

export type ActionKind = Action["kind"];

export interface Decision {
  action: Action;
  rationale: string;
  confidence: number;
  actor: "fast" | "agent" | "human" | "webhook";
  /**
   * When this case should be looked at again. Until then the decision stands
   * and the router will not re-escalate it. Without this the same unchanged
   * case went to the agent every tick, 18.7 times per invoice, worst case 45
   * consecutive days of identical reasoning, which is both a cost problem and
   * wrong: the agent already said what to do.
   */
  nextReviewAt?: CivilDate;
  /** Present when the agent decided; lets the UI show what it read. */
  toolCalls?: { name: string; args: unknown }[];
}

export interface Policy {
  contactWindow: { start: string; end: string; tz: "Asia/Kolkata"; holidays: string };
  maxTouches: number;
  minGapDays: number;
  campaignDays: number;
  ladder: readonly Rung[];
  /** Pre-due nudge fires this many days before the due date. */
  preDueDays: number;
  /** Silent this long past due and the router hands the case to the agent. */
  escalateAfterSilentDays: number;
  /** A dispute open longer than this goes to the agent. */
  disputeStaleDays: number;
  /** Reply parses below this go to a human. */
  minParseConfidence: number;
  /**
   * Minimum days since the last touch before each ladder rung may fire,
   * indexed to `ladder`. Widening as the ladder climbs is deliberate: a
   * reminder arriving on a fixed short cadence reads as an automated dunning
   * machine, and buyers who feel harassed pay later, not sooner.
   */
  rungGapDays: number[];
  /**
   * Buyers who have taken this many touches without ever replying get their
   * gap multiplied. Derived from observed replies-per-touch, which is in the
   * ledger; nothing here reads a buyer's hidden disposition.
   */
  silentBackoffAfterTouches: number;
  silentBackoffMultiplier: number;
  /**
   * Hard ceiling on touches to a buyer who has never replied. Past this the
   * case goes to a human instead of climbing further. A buyer who has ignored
   * three messages is not going to be moved by a fourth, and the evidence that
   * the automated path is working ran out two touches ago.
   */
  silentTouchCap: number;
  /**
   * When Baaki picks up the phone. Absent means never, which is how the
   * simulator runs: it models messages moving a payment hazard and has no
   * representation of a conversation, so a policy that placed calls inside it
   * would be measuring a fiction. Every collection figure in `evals/report.md`
   * therefore describes the message-only policy.
   */
  voice?: VoicePolicy;
  policyVersion: string;
}

export interface VoicePolicy {
  enabled: boolean;
  /**
   * Days past due with no reply and no button press before a call is worth
   * placing. The trigger is missing information, not elapsed time: WhatsApp is
   * the cheap probe, and you only pay for the expensive one when the cheap one
   * came back empty.
   */
  afterSilentDays: number;
  /** Also call when a promised date passes with no payment and no explanation. */
  onBrokenPromise: boolean;
  /**
   * Calls permitted for the whole life of the invoice, not per rung. A second
   * unanswered call says nothing the first did not.
   */
  maxCalls: number;
  /**
   * Tighter than the message window on purpose. A WhatsApp at nine in the
   * evening is rude; a phone call at nine in the evening is a different
   * category of offence.
   */
  window: { start: string; end: string };
}

export const DEFAULT_POLICY: Policy = {
  contactWindow: { start: "09:00", end: "18:00", tz: "Asia/Kolkata", holidays: "IN-KA" },
  maxTouches: 5,
  minGapDays: 3,
  campaignDays: 90,
  ladder: LADDER,
  preDueDays: 3,
  escalateAfterSilentDays: 14,
  disputeStaleDays: 3,
  minParseConfidence: 0.6,
  // Wide by measurement, not by taste. At [0,3,7,11,14] the ladder put three
  // touches inside every persona's 7-day over-contact window; complaints and
  // opt-outs ran at ~26 and ~23 per 1200 invoices. At these gaps both are zero
  // and collection is higher. See evals/report.md §5.
  rungGapDays: [0, 10, 10, 14, 18],
  silentBackoffAfterTouches: 2,
  silentBackoffMultiplier: 2,
  silentTouchCap: 4,
  // Off here so the simulator, and therefore every published number, stays a
  // measurement of the message-only policy. `LIVE_POLICY` turns it on.
  voice: { enabled: false, afterSilentDays: 12, onBrokenPromise: true, maxCalls: 1, window: { start: "10:00", end: "18:00" } },
  policyVersion: "p3",
};

/**
 * The same product on a compressed calendar, for showing the whole arc of an
 * invoice in a few minutes.
 *
 * Every gap is shortened and nothing else changes: the same guards run, the
 * same router decides, the same ladder climbs. It is a separate policy rather
 * than an edit to the shipped one because a two-day cadence is a bad policy and
 * the measurement says so. At gaps like these the ladder put three touches
 * inside every persona's over-contact window and produced 55 complaints and 26
 * opt-outs while collecting no more money, which is exactly why the shipped
 * gaps are 10 to 18 days. Anywhere this policy is used, say so on screen.
 */
export const DEMO_POLICY: Policy = {
  ...DEFAULT_POLICY,
  preDueDays: 1,
  rungGapDays: [0, 2, 2, 2, 2],
  minGapDays: 1,
  campaignDays: 30,
  silentBackoffAfterTouches: 99,   // no backoff: it would stretch the demo out again
  silentTouchCap: 6,
  escalateAfterSilentDays: 4,
  voice: { enabled: true, afterSilentDays: 2, onBrokenPromise: true, maxCalls: 2, window: { start: "09:00", end: "21:00" } },
  policyVersion: "p3-demo",
};

/**
 * What the deployed product runs: the measured policy plus the phone. Split
 * from `DEFAULT_POLICY` rather than folded into it so that turning voice on
 * can never silently change what the evals are describing.
 */
export const LIVE_POLICY: Policy = {
  ...DEFAULT_POLICY,
  voice: { ...DEFAULT_POLICY.voice!, enabled: true },
  policyVersion: "p3-live",
};
