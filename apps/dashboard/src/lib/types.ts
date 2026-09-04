/** Shape of apps/dashboard/data/snapshot.json, emitted by packages/sim/src/snapshot.ts. */

export type Substate = "awaiting_reply" | "promised" | "disputed" | "human_hold" | "paid" | "closed";
export type Rung = "pre_due" | "whatsapp" | "whatsapp+reissue" | "owner_whatsapp" | "human";

export interface Invoice {
  id: string;
  buyerId: string;
  amount: number;
  amountPaid: number;
  issuedOn: string;
  dueOn: string;
  linkExpiresOn: string | null;
  state: "open" | "due" | "overdue";
  substate: Substate;
  promisedFor: string | null;
  disputeReason: string | null;
  campaignEndsOn: string;
  arm: "baaki" | "baseline";
  closedOn: string | null;
  closedReason: string | null;
}

export interface Memory {
  buyerId: string;
  avgDaysLate: number;
  promiseKeptRate: number;
  disputeRate: number;
  repliesPerTouch: { whatsapp: number; email: number };
  lastReplyHour: number | null;
  language: string;
  doNotContact: boolean;
  counts: {
    invoices: number;
    promisesMade: number;
    promisesKept: number;
    disputesRaised: number;
    touches: { whatsapp: number; email: number };
    replies: { whatsapp: number; email: number };
  };
}

export type Action =
  | { kind: "none"; reason: string }
  | { kind: "send_nudge"; channel: string; persona: string; rung: Rung; draft: string }
  | { kind: "reissue_payment_path" }
  | { kind: "schedule_wait"; until: string; reason: string }
  | { kind: "open_dispute"; reason: string }
  | { kind: "escalate_to_human"; reason: string }
  | { kind: "stop"; reason: string };

export interface GuardResult { name: string; pass: boolean; detail?: string }

export interface TimelineEvent {
  ts: number;
  type: "touch" | "reply" | "payment" | "decision";
  id: string;
  summary: string;
  detail: Record<string, unknown>;
  evidence: string[];
}

export interface StorySentence { text: string; cites: string[] }

export interface CaseView {
  invoice: Invoice;
  buyer: { id: string; name: string; phone: string };
  memory: Memory;
  daysOverdue: number;
  outstanding: number;
  nextRung: Rung;
  proposal: {
    route: "fast" | "slow";
    routeReason: string;
    action: Action;
    rationale: string;
    guards: GuardResult[];
    allowed: boolean;
  };
  story: StorySentence[];
  timeline: TimelineEvent[];
}

export interface Snapshot {
  seed: number;
  day: number;
  date: string;
  generatedBy: string;
  totals: {
    invoices: number;
    open: number;
    overdue: number;
    outstanding: number;
    billed: number;
    collected: number;
    onPromise: number;
    disputed: number;
    humanHold: number;
  };
  cases: CaseView[];
}
