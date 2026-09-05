/** The webhook service is the only writer of ledger state; the dashboard reads it. */
/**
 * Same origin in production: the dashboard and its API are one deployment.
 * NEXT_PUBLIC_API only exists for pointing a local UI at a running service.
 */
export const API = process.env.NEXT_PUBLIC_API ?? "";

export interface Contact {
  id: string; name: string; phone: string; email?: string; city: string;
  termDays: number; language: string; sendable: boolean; notes?: string;
}

export interface LiveInvoice {
  invoice: {
    id: string; buyerId: string; amount: number; amountPaid: number;
    issuedOn: string; dueOn: string; linkExpiresOn: string | null;
    state: string; substate: string; promisedFor: string | null;
    disputeReason: string | null; campaignEndsOn: string;
    closedOn: string | null; closedReason: string | null;
  };
  buyer: { id: string; name: string; phone: string };
  memory: {
    avgDaysLate: number; promiseKeptRate: number; disputeRate: number;
    repliesPerTouch: { whatsapp: number; email: number };
    language: string; doNotContact: boolean;
    counts: { invoices: number; promisesMade: number; promisesKept: number; disputesRaised: number };
  };
  daysOverdue: number;
  outstanding: number;
  external: { shortUrl?: string; razorpayPaymentLinkId?: string; razorpayCustomerId?: string; virtualAccountId?: string };
  touches: { id: string; ts: number; rung: string; persona: string; carriedLiveLink: boolean; body: string }[];
  replies: { id: string; ts: number; source: string; text: string; intent: string; promiseDate?: string; confidence: number }[];
  payments: { id: string; ts: number; amount: number; evidence: string }[];
  audit: {
    id: string; ts: number; actor: string; action: string; rationale: string;
    guards: { name: string; pass: boolean; detail?: string }[];
    evidence: string[]; params: Record<string, unknown>;
  }[];
}

export interface Policy {
  contactWindow: { start: string; end: string; tz: string; holidays: string };
  maxTouches: number; minGapDays: number; campaignDays: number;
  preDueDays: number; escalateAfterSilentDays: number; disputeStaleDays: number;
  minParseConfidence: number; rungGapDays: number[];
  silentBackoffAfterTouches: number; silentBackoffMultiplier: number; silentTouchCap: number;
  policyVersion: string;
}

export interface AppState {
  /** How far ahead of real time the app is running. Zero outside a demo. */
  demoOffsetMs?: number; policy: Policy; invoices: LiveInvoice[]; contacts: Contact[] }

export interface TickAction {
  invoiceId: string; buyer: string; route: "fast" | "slow"; routeReason: string;
  action: { kind: string; [k: string]: unknown };
  rationale: string;
  guards: { name: string; pass: boolean; detail?: string }[];
  applied: boolean; blocked?: string;
  sent?: { messageId: string; template: string | null; dryRun: boolean };
  error?: string;
}

export interface TickReport {
  ranAt: number; today: string; considered: number; actions: TickAction[];
  fastCount: number; slowCount: number; sentCount: number; blockedCount: number;
}

export async function getState(): Promise<AppState> {
  const base = API || (typeof window === "undefined" ? process.env.INTERNAL_ORIGIN ?? "http://localhost:3000" : "");
  const r = await fetch(`${base}/api/state`, { cache: "no-store" });
  if (!r.ok) throw new Error(`state ${r.status}`);
  return r.json();
}
