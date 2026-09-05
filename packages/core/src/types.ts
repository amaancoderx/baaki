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
   * When a decider last acted on this invoice. A reply is "handled" once a
   * decision postdates it, even a decision that sends nothing — otherwise a
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
   * question becomes the useful one — does the case contain information the
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
   * case went to the agent every tick — 18.7 times per invoice, worst case 45
   * consecutive days of identical reasoning — which is both a cost problem and
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
  policyVersion: string;
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
  policyVersion: "p3",
};
