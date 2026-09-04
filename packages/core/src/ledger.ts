import { AuditLog, type GuardResult } from "./audit.js";
import { computeMemory, emptyMemory } from "./memory.js";
import { addDays, daysBetween, istParts, systemClock, type CivilDate, type Clock } from "./time.js";
import type {
  Buyer, BuyerMemory, CaseFile, Invoice, Payment, Policy, Reply, Rung, Touch,
} from "./types.js";
import { DEFAULT_POLICY } from "./types.js";

const TERMINAL: ReadonlySet<Invoice["substate"]> = new Set(["paid", "closed"]);

/**
 * States the automated ladder may not pull an invoice out of. `human_hold`
 * belongs here as much as `paid` does: once a person owns a case, an inbound
 * promise is information for that person, not a signal that hands the case
 * back to the machine.
 */
const AGENT_MAY_NOT_REOPEN: ReadonlySet<Invoice["substate"]> = new Set(["paid", "closed", "human_hold"]);

export interface LedgerOptions {
  policy?: Policy;
  /** The sim drives this. Audit timestamps must follow simulated time, not wall clock. */
  clock?: Clock;
}

/**
 * One record per invoice, plus the event logs the case file is assembled from.
 * The store is in-memory; the sim runs thousands of these and the dashboard
 * reads a snapshot, so persistence is a serialisation concern, not a core one.
 */
export class Ledger {
  readonly policy: Policy;
  readonly clock: Clock;
  readonly audit = new AuditLog();

  #buyers = new Map<string, Buyer>();
  #memory = new Map<string, BuyerMemory>();
  #invoices = new Map<string, Invoice>();
  #touches: Touch[] = [];
  #replies: Reply[] = [];
  #payments: Payment[] = [];
  #seq = 0;

  constructor(opts: LedgerOptions = {}) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.clock = opts.clock ?? systemClock();
  }

  id(prefix: string): string {
    return `${prefix}_${++this.#seq}`;
  }

  // -- registration ---------------------------------------------------------

  addBuyer(b: Buyer, language: BuyerMemory["language"] = "hinglish"): void {
    this.#buyers.set(b.id, b);
    if (!this.#memory.has(b.id)) this.#memory.set(b.id, emptyMemory(b.id, language));
  }

  addInvoice(inv: Invoice): void {
    this.#invoices.set(inv.id, inv);
  }

  // -- reads ----------------------------------------------------------------

  buyer(id: string): Buyer {
    const b = this.#buyers.get(id);
    if (!b) throw new Error(`unknown buyer ${id}`);
    return b;
  }

  invoice(id: string): Invoice {
    const i = this.#invoices.get(id);
    if (!i) throw new Error(`unknown invoice ${id}`);
    return i;
  }

  invoices(): Invoice[] {
    return [...this.#invoices.values()];
  }

  openInvoices(): Invoice[] {
    return this.invoices().filter((i) => !TERMINAL.has(i.substate));
  }

  memory(buyerId: string): BuyerMemory {
    return this.#memory.get(buyerId) ?? emptyMemory(buyerId);
  }

  touchesFor(invoiceId: string): Touch[] {
    return this.#touches.filter((t) => t.invoiceId === invoiceId);
  }

  repliesFor(invoiceId: string): Reply[] {
    return this.#replies.filter((r) => r.invoiceId === invoiceId);
  }

  paymentsFor(invoiceId: string): Payment[] {
    return this.#payments.filter((p) => p.invoiceId === invoiceId);
  }

  allTouches(): readonly Touch[] { return this.#touches; }
  allReplies(): readonly Reply[] { return this.#replies; }
  allPayments(): readonly Payment[] { return this.#payments; }

  // -- state derivation -----------------------------------------------------

  /** `open → due → overdue` is a function of the calendar, not of events. */
  refreshState(inv: Invoice, today: CivilDate): void {
    if (TERMINAL.has(inv.substate)) return;
    const d = daysBetween(inv.dueOn, today);
    inv.state = d < 0 ? "open" : d === 0 ? "due" : "overdue";
  }

  refreshAll(today: CivilDate): void {
    for (const inv of this.#invoices.values()) this.refreshState(inv, today);
  }

  daysOverdue(inv: Invoice, today: CivilDate): number {
    return Math.max(0, daysBetween(inv.dueOn, today));
  }

  /** The rung a fresh touch would occupy: one past the highest already sent. */
  nextRung(inv: Invoice): Rung {
    const ladder = this.policy.ladder;
    const sent = this.touchesFor(inv.id);
    if (sent.length === 0) return ladder[0]!;
    let highest = -1;
    for (const t of sent) {
      const idx = ladder.indexOf(t.rung);
      if (idx > highest) highest = idx;
    }
    return ladder[Math.min(highest + 1, ladder.length - 1)]!;
  }

  caseFile(invoiceId: string, nowMs: number): CaseFile {
    const inv = this.invoice(invoiceId);
    const today = istParts(nowMs).date;
    this.refreshState(inv, today);
    return {
      today,
      nowMs,
      invoice: inv,
      buyer: this.buyer(inv.buyerId),
      memory: this.memory(inv.buyerId),
      touches: this.touchesFor(invoiceId),
      replies: this.repliesFor(invoiceId),
      payments: this.paymentsFor(invoiceId),
      daysOverdue: this.daysOverdue(inv, today),
      nextRung: this.nextRung(inv),
      policy: this.policy,
    };
  }

  // -- transitions ----------------------------------------------------------

  recordTouch(t: Omit<Touch, "id">, guards: GuardResult[], rationale: string, actor: "fast" | "agent" | "human"): Touch {
    const touch: Touch = { id: this.id("t"), ...t };
    this.#touches.push(touch);
    const inv = this.invoice(t.invoiceId);
    if (inv.substate !== "disputed" && inv.substate !== "human_hold" && !TERMINAL.has(inv.substate)) {
      inv.substate = "awaiting_reply";
    }
    this.audit.append({
      ts: t.ts,
      invoiceId: t.invoiceId,
      actor,
      action: "send_nudge",
      params: { channel: t.channel, persona: t.persona, rung: t.rung, carriedLiveLink: t.carriedLiveLink },
      rationale,
      guards,
      policyVersion: this.policy.policyVersion,
      evidence: [touch.id],
    });
    this.#recomputeMemory(t.buyerId);
    return touch;
  }

  recordReply(r: Omit<Reply, "id">): Reply {
    const reply: Reply = { id: this.id("r"), ...r };
    this.#replies.push(reply);
    const inv = this.invoice(r.invoiceId);

    // Button payloads and high-confidence parses move the ledger directly.
    if (reply.intent === "stop") {
      const mem = this.memory(r.buyerId);
      mem.doNotContact = true;
      this.#memory.set(r.buyerId, mem);
      this.#audit(inv.id, "webhook", "stop", { via: "buyer opt-out" },
        "Buyer asked to stop. do_not_contact set permanently for this buyer.", [reply.id], reply.ts);
    } else if (reply.intent === "promise" && reply.promiseDate && !AGENT_MAY_NOT_REOPEN.has(inv.substate)) {
      inv.substate = "promised";
      inv.promisedFor = reply.promiseDate;
      this.#audit(inv.id, "webhook", "schedule_wait", { until: reply.promiseDate },
        `Buyer promised payment by ${reply.promiseDate}. Outreach frozen until the day after.`, [reply.id], reply.ts);
    } else if (reply.intent === "dispute" && !AGENT_MAY_NOT_REOPEN.has(inv.substate)) {
      inv.substate = "disputed";
      inv.disputeReason = reply.disputeReason ?? reply.text;
      this.#audit(inv.id, "webhook", "open_dispute", { reason: inv.disputeReason },
        "Buyer raised a query. Outreach frozen and the merchant is notified; no agent argues a dispute.", [reply.id], reply.ts);
    }

    if (AGENT_MAY_NOT_REOPEN.has(inv.substate) && inv.substate === "human_hold" &&
        (reply.intent === "promise" || reply.intent === "dispute")) {
      this.#audit(inv.id, "webhook", "none", { intent: reply.intent, text: reply.text },
        `Buyer sent a ${reply.intent} while this case was on human_hold. Recorded for the owner; the invoice stays with the human and no outreach resumes.`,
        [reply.id], reply.ts);
    }

    this.#recomputeMemory(r.buyerId);
    return reply;
  }

  recordPayment(p: Omit<Payment, "id">): Payment {
    const pay: Payment = { id: this.id("p"), ...p };
    this.#payments.push(pay);
    const inv = this.invoice(p.invoiceId);
    inv.amountPaid += p.amount;

    if (inv.amountPaid >= inv.amount) {
      inv.substate = "paid";
      inv.closedOn = istParts(p.ts).date;
      inv.closedReason = "paid in full";
      this.#audit(inv.id, "webhook", "stop", { amount: p.amount, total: inv.amountPaid },
        "Razorpay confirmed payment in full. Campaign stops.", [pay.evidence, pay.id], pay.ts);
    } else {
      this.#audit(inv.id, "webhook", "none", { amount: p.amount, outstanding: inv.amount - inv.amountPaid },
        `Partial payment received. ${inv.amount - inv.amountPaid} paise still outstanding.`, [pay.evidence, pay.id], pay.ts);
    }
    this.#recomputeMemory(inv.buyerId);
    return pay;
  }

  setSubstate(
    invoiceId: string,
    substate: Invoice["substate"],
    rationale: string,
    actor: "fast" | "agent" | "human",
    evidence: string[],
    extra: Partial<Pick<Invoice, "promisedFor" | "disputeReason" | "closedOn" | "closedReason">> = {},
  ): void {
    const inv = this.invoice(invoiceId);
    inv.substate = substate;
    Object.assign(inv, extra);
    const action = substate === "human_hold" ? "escalate_to_human"
      : substate === "disputed" ? "open_dispute"
      : substate === "promised" ? "schedule_wait"
      : substate === "closed" ? "stop"
      : "none";
    this.#audit(invoiceId, actor, action, { substate, ...extra }, rationale, evidence);
  }

  reissuePaymentPath(invoiceId: string, today: CivilDate, days: number, rationale: string, actor: "fast" | "agent"): void {
    const inv = this.invoice(invoiceId);
    const link = this.id("plink");
    inv.linkExpiresOn = addDays(today, days);
    this.#audit(invoiceId, actor, "reissue_payment_path",
      { paymentLinkId: link, expireBy: inv.linkExpiresOn }, rationale, [link]);
  }

  linkIsLive(inv: Invoice, today: CivilDate): boolean {
    return inv.linkExpiresOn !== null && daysBetween(today, inv.linkExpiresOn) >= 0;
  }

  #audit(
    invoiceId: string,
    actor: "fast" | "agent" | "human" | "webhook",
    action: Parameters<AuditLog["append"]>[0]["action"],
    params: Record<string, unknown>,
    rationale: string,
    evidence: string[],
    ts: number = this.clock.now(),
    guards: GuardResult[] = [],
  ): void {
    this.audit.append({
      ts,
      invoiceId, actor, action, params, rationale, guards,
      policyVersion: this.policy.policyVersion,
      evidence,
    });
  }

  #recomputeMemory(buyerId: string): void {
    const buyer = this.#buyers.get(buyerId);
    if (!buyer) return;
    const invs = this.invoices().filter((i) => i.buyerId === buyerId);
    const byInvoice = new Map<string, Payment[]>();
    for (const p of this.#payments) {
      const arr = byInvoice.get(p.invoiceId) ?? [];
      arr.push(p);
      byInvoice.set(p.invoiceId, arr);
    }
    const next = computeMemory(
      buyer,
      this.memory(buyerId),
      invs,
      this.#touches.filter((t) => t.buyerId === buyerId),
      this.#replies.filter((r) => r.buyerId === buyerId),
      byInvoice,
    );
    this.#memory.set(buyerId, next);
  }
}
