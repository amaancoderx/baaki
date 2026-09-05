import { runCaseAgent, type AgentOptions } from "./agent/index.js";
import type { AuditEntry, GuardResult } from "./audit.js";
import { buttonIntent, isOptOut, parseWebhook, type WhatsappClient } from "./channels/whatsapp.js";
import { extractAddress, extractReplyText } from "./channels/email.js";
import type { Contact } from "./contacts.js";
import { runGuards } from "./guards/index.js";
import type { Ledger } from "./ledger.js";
import type { Llm } from "./llm/types.js";
import { formatINR, type Paise } from "./money.js";
import { fastPath, voiceCall } from "./policy.js";
import { parseRzpEvent, type RazorpayClient, type RzpEvent } from "./razorpay/index.js";
import { route } from "./router.js";
import { invoiceLock, Locks, TICK_LOCK, type LockRedis } from "./locks.js";
import type { LedgerStoreLike } from "./store.js";
import { addDays, formatCivilShort, istParts, type Clock, type CivilDate } from "./time.js";
import { templateDraft } from "./drafts.js";
import { understandReply } from "./understand.js";
import type { Action, Buyer, Channel, Decision, Invoice, Policy, Rung } from "./types.js";

/** Which approved template carries which rung. */
export const RUNG_TEMPLATE: Record<Rung, string | null> = {
  pre_due: "baaki_predue_reminder",
  whatsapp: "baaki_invoice_reminder",
  "whatsapp+reissue": "baaki_invoice_reminder",
  owner_whatsapp: "baaki_owner_followup",
  human: null,
};

/**
 * Places the call. Injected rather than built here so core never has to know
 * a telephony vendor or this deployment's public origin.
 */
export interface VoiceCaller {
  placeCall(input: { to: string; invoiceId: string; buyerName: string }): Promise<{
    sid: string;
    status: string;
    dryRun?: boolean;
  }>;
}

export interface BaakiConfig {
  store: LedgerStoreLike;
  policy: Policy;
  razorpay?: RazorpayClient;
  whatsapp?: WhatsappClient;
  voice?: VoiceCaller;
  llm?: Llm;
  agent?: AgentOptions;
  clock: Clock;
  /** Set when the payment link should be shortened for the template button. */
  linkBase?: string;
  /** Needed to check which templates Meta has approved. */
  wabaId?: string;
  /**
   * Serialises work on the same invoice and drops redelivered events. Without
   * it a webhook and a tick can both act on one invoice from different
   * instances, which is how a nudge goes out seconds after payment.
   */
  redis?: LockRedis;
}

export interface CreateInvoiceInput {
  contact: Contact;
  amount: Paise;
  description: string;
  termDays: number;
  /** Days from now the payment path expires. Short values create dead links on purpose. */
  linkValidDays?: number;
  createVirtualAccount?: boolean;
  /**
   * Backdates the issue date. A merchant onboarding to Baaki arrives with a
   * book of already-overdue invoices, and this is how they are brought in: the
   * ledger dates are historical while the Razorpay payment path is created now.
   */
  issuedDaysAgo?: number;
}

export interface Delivery {
  /**
   * Razorpay was asked to email the link and accepted the request. Note the
   * word asked: acceptance is not delivery, and in test mode Razorpay does not
   * dispatch customer notification emails at all. Reporting this as "emailed"
   * claimed something never observed.
   */
  emailRequested: boolean;
  /** Razorpay confirmed it dispatched the email. This is the one worth trusting. */
  emailSent: boolean;
  /** Meta message id, or null when WhatsApp is not configured or the send failed. */
  whatsappMessageId: string | null;
  whatsappTemplate: string | null;
  /** True when the intended template is still in Meta review and an approved opener went instead. */
  templatePending?: boolean;
  dryRun?: boolean;
  skipped?: string;
}

export interface CreatedInvoice {
  invoice: Invoice;
  delivered?: Delivery;
  razorpay?: {
    customerId: string;
    invoiceId?: string;
    paymentLinkId?: string;
    shortUrl?: string;
    /** What Razorpay reported, not what was requested. */
    emailStatus?: "sent" | "pending" | null;
    virtualAccount?: { id: string; account?: string; ifsc?: string; vpa?: string };
  };
}

export interface TickAction {
  invoiceId: string;
  buyer: string;
  route: "fast" | "slow";
  routeReason: string;
  action: Action;
  rationale: string;
  guards: GuardResult[];
  applied: boolean;
  blocked?: string;
  /** Present when a message actually left the system. */
  sent?: { messageId: string; template: string | null; dryRun: boolean };
  error?: string;
}

export interface TickReport {
  /**
   * True when another pass held the ledger and this one did nothing. Distinct
   * from a pass that ran and found nothing to do.
   */
  lockHeld?: boolean;
  ranAt: number;
  today: CivilDate;
  considered: number;
  actions: TickAction[];
  fastCount: number;
  slowCount: number;
  sentCount: number;
  blockedCount: number;
}

/**
 * The live loop. Same decide → guard → act → audit path as the simulator; the
 * difference is that acting sends a real WhatsApp message and the payment
 * evidence arrives from a real Razorpay webhook.
 */
export class Baaki {
  readonly #locks: Locks | null;

  constructor(private readonly cfg: BaakiConfig) {
    this.#locks = cfg.redis ? new Locks(cfg.redis) : null;
  }

  get store(): LedgerStoreLike { return this.cfg.store; }
  get policy(): Policy { return this.cfg.policy; }

  private today(): CivilDate {
    return istParts(this.cfg.clock.now()).date;
  }

  // -- creating work ---------------------------------------------------------

  /**
   * Issues a real Razorpay invoice and payment link, then mirrors it into the
   * ledger. Razorpay stays the source of truth for money; the ledger owns the
   * chasing state Razorpay has no concept of.
   */
  async createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const today = this.today();
    const issuedOn = addDays(today, -(input.issuedDaysAgo ?? 0));
    const dueOn = addDays(issuedOn, input.termDays);
    const linkValidDays = input.linkValidDays ?? input.termDays + 7;
    // The ledger keeps the civil expiry date it computed, which may well be in
    // the past: that is how an already-overdue book arrives, and a dead link is
    // the condition reissue exists to repair. Razorpay refuses to mint a link
    // that has already expired, so what it is asked for is floored at a real
    // near-future time. The two disagree on purpose.
    const wantedExpiry = Date.parse(`${addDays(today, linkValidDays)}T18:00:00+05:30`);
    const expireBy = Math.floor(Math.max(wantedExpiry, Date.now() + 30 * 60_000) / 1000);

    let rzp: CreatedInvoice["razorpay"];
    let emailSent = false;

    if (this.cfg.razorpay) {
      const customer = await this.cfg.razorpay.createCustomer({
        name: input.contact.name,
        contact: input.contact.phone,
        ...(input.contact.email ? { email: input.contact.email } : {}),
        notes: { baaki_contact_id: input.contact.id, city: input.contact.city },
      });

      // A Razorpay Invoice, not a payment link, is the primary path.
      //
      // It is the right primitive: it is literally an invoice, it carries the
      // line item and the expiry, and it produces a payment page. It is also
      // the one that reaches the buyer. Payment links accept `notify.email`
      // and report success, but dispatch nothing in test mode, so the email
      // leg looked wired and delivered nothing. An invoice comes back with
      // `email_status: "sent"`, which is evidence rather than an assumption.
      //
      // Payment links remain the reissue path, where a fresh URL is all that
      // is wanted.
      const inv = await this.cfg.razorpay.createInvoice({
        customerId: customer.id,
        amount: input.amount,
        description: input.description,
        receipt: `baaki_${Date.now()}`,
        expireBy,
        notes: { baaki_contact_id: input.contact.id },
        // One dispatch, from Razorpay, at issue. Everything after it is Baaki's
        // and passes the guards.
        notify: { email: Boolean(input.contact.email), sms: false },
      });

      // The create response comes back with email_status "pending": the
      // dispatch settles a moment later. Reading it once more is the difference
      // between reporting what was queued and reporting what was sent.
      let emailStatus = inv.email_status ?? null;
      // The dispatch settles a couple of seconds after the invoice is created,
      // so one immediate read always comes back pending and the screen says
      // "not confirmed" about an email that did in fact go.
      for (let i = 0; emailStatus === "pending" && i < 4; i++) {
        await new Promise((r) => setTimeout(r, 1_200));
        try {
          const settled = await this.cfg.razorpay.getInvoice(inv.id);
          emailStatus = settled.email_status ?? emailStatus;
        } catch {
          // Leave it as pending. Claiming more than we saw is the bug this
          // whole path exists to avoid.
          break;
        }
      }

      rzp = {
        customerId: customer.id,
        invoiceId: inv.id,
        shortUrl: inv.short_url,
        emailStatus,
      };
      emailSent = emailStatus === "sent";

      if (input.createVirtualAccount) {
        try {
          const va = await this.cfg.razorpay.createVirtualAccount({
            customerId: customer.id,
            description: `Baaki collections for ${input.contact.name}`,
            notes: { baaki_contact_id: input.contact.id },
          });
          const bank = va.receivers.find((r) => r.account_number);
          const vpa = va.receivers.find((r) => r.address);
          rzp.virtualAccount = {
            id: va.id,
            ...(bank?.account_number ? { account: bank.account_number, ifsc: bank.ifsc } : {}),
            ...(vpa?.address ? { vpa: vpa.address } : {}),
          };
        } catch {
          // Smart Collect is not enabled on every test account. Not fatal:
          // the payment link is a complete path on its own.
        }
      }
    }

    const created = await this.cfg.store.update((ledger) => {
      const buyer: Buyer = {
        id: input.contact.id, name: input.contact.name, phone: input.contact.phone,
        ...(input.contact.email ? { email: input.contact.email } : {}),
        ...(input.contact.sendable === false ? { reachable: false } : {}),
      };
      ledger.addBuyer(buyer, input.contact.language);

      const invoice: Invoice = {
        id: ledger.id("inv"),
        buyerId: buyer.id,
        amount: input.amount,
        amountPaid: 0,
        issuedOn,
        dueOn,
        linkExpiresOn: addDays(issuedOn, linkValidDays),
        state: "open",
        substate: "awaiting_reply",
        promisedFor: null,
        disputeReason: null,
        campaignEndsOn: addDays(dueOn, this.cfg.policy.campaignDays),
        arm: "baaki",
        closedOn: null,
        closedReason: null,
      };
      ledger.addInvoice(invoice);
      ledger.noteExternal(invoice.id, {
        razorpayCustomerId: rzp?.customerId,
        // Both, because the primary path is an invoice and reissue mints a
        // payment link. Dropping the invoice id meant an invoice.paid webhook
        // matched nothing and the money never reached the case.
        razorpayInvoiceId: rzp?.invoiceId,
        razorpayPaymentLinkId: rzp?.paymentLinkId,
        shortUrl: rzp?.shortUrl,
        virtualAccountId: rzp?.virtualAccount?.id,
      });
      ledger.audit.append({
        ts: this.cfg.clock.now(),
        invoiceId: invoice.id,
        actor: "human",
        action: "none",
        params: { amount: input.amount, dueOn, ...(rzp ?? {}) },
        rationale: `Invoice raised for ${input.contact.name}: ${formatINR(input.amount)} due ${formatCivilShort(dueOn)}${rzp?.shortUrl ? `, payment link ${rzp.shortUrl}` : ""}.`,
        guards: [],
        policyVersion: this.cfg.policy.policyVersion,
        evidence: [rzp?.paymentLinkId ?? invoice.id],
      });
      return invoice;
    }, this.cfg.policy);

    const delivered = await this.#deliver(created, input.contact, rzp?.shortUrl, emailSent);

    return { invoice: created, razorpay: rzp, ...(delivered ? { delivered } : {}) };
  }

  /**
   * Hands the buyer the bill on both channels at once, then writes one entry
   * saying so. Razorpay has already emailed the link by the time this runs;
   * this adds the WhatsApp and records the pair.
   *
   * Not a touch. A touch is collection outreach, and the over-contact model in
   * the simulator is calibrated on outreach a buyer did not ask for. Counting
   * the invoice itself against that budget would mean a buyer who pays on time
   * still arrived one message closer to being left alone.
   */
  async #deliver(invoice: Invoice, contact: Contact, shortUrl?: string, emailSent = false): Promise<Delivery | undefined> {
    const emailRequested = Boolean(contact.email) && Boolean(this.cfg.razorpay);
    const base: Delivery = { emailRequested, emailSent, whatsappMessageId: null, whatsappTemplate: null };

    const ledger = await this.cfg.store.load(this.cfg.policy);
    if (ledger.memory(contact.id).doNotContact) {
      const skipped: Delivery = { ...base, emailRequested: false, skipped: "buyer is on do_not_contact" };
      await this.#recordDelivery(invoice, skipped, shortUrl);
      return skipped;
    }

    let out = base;
    if (this.cfg.whatsapp) {
      try {
        const usable = await this.usableTemplate(RUNG_TEMPLATE.whatsapp!);
        if (!usable) {
          out = { ...base, skipped: "no approved WhatsApp template is available yet" };
        } else {
          const res = usable.isFallback
            ? await this.cfg.whatsapp.sendTemplate({ to: contact.phone, template: usable.template, language: "en_US", bodyParams: [] })
            : await this.cfg.whatsapp.sendTemplate({
                to: contact.phone,
                template: usable.template,
                language: "en",
                bodyParams: [
                  contact.name,
                  invoice.id,
                  formatINR(invoice.amount).replace("₹", "Rs "),
                  formatCivilShort(invoice.dueOn),
                ],
                ...(shortUrl ? { urlButtonSuffix: shortUrl.split("/").pop() ?? "" } : {}),
              });
          out = {
            ...base,
            whatsappMessageId: res.messageId,
            whatsappTemplate: usable.template,
            ...(usable.isFallback ? { templatePending: true } : {}),
            ...(res.dryRun ? { dryRun: true } : {}),
          };
        }
      } catch (e) {
        out = { ...base, skipped: e instanceof Error ? e.message : String(e) };
      }
    }

    await this.#recordDelivery(invoice, out, shortUrl);
    return out;
  }

  async #recordDelivery(invoice: Invoice, d: Delivery, shortUrl?: string): Promise<void> {
    const channels: Channel[] = [];
    if (d.emailSent) channels.push("email");
    if (d.whatsappMessageId) channels.push("whatsapp");

    const where = channels.length === 0
      ? "no channel was available"
      : channels.length === 2 ? "email and WhatsApp" : channels[0] === "email" ? "email" : "WhatsApp";

    await this.cfg.store.update((ledger) => {
      ledger.audit.append({
        ts: this.cfg.clock.now(),
        invoiceId: invoice.id,
        // Baaki sends it, not the merchant. The merchant raised the invoice;
        // the entry above this one is theirs.
        actor: "agent",
        action: "deliver_invoice",
        params: { channels, template: d.whatsappTemplate, ...(d.skipped ? { skipped: d.skipped } : {}) },
        rationale: d.skipped
          ? `Invoice not delivered: ${d.skipped}.`
          : `Invoice sent on ${where}. This is the bill, not a reminder, so it does not count against the ${this.cfg.policy.maxTouches}-message budget.`
            + (d.templatePending ? " The invoice template is still in Meta review, so an approved opener went instead." : ""),
        guards: [],
        policyVersion: this.cfg.policy.policyVersion,
        evidence: [d.whatsappMessageId, shortUrl, invoice.id].filter(Boolean) as string[],
      });
      return invoice;
    }, this.cfg.policy);
  }

  // -- the loop --------------------------------------------------------------

  async tick(): Promise<TickReport> {
    // One pass at a time. Two overlapping ticks would each read the ledger,
    // decide independently, and both send.
    if (this.#locks) {
      // The ceiling matters more than it looks: a function killed mid-tick leaves
      // the lock to expire on its own, and at 280s that reads as minutes of a
      // dead button. The platform kills the function at 120s, so holding the
      // lock longer than that only ever protects a corpse.
      const out = await this.#locks.tryWith(TICK_LOCK, () => this.#tick(), 120_000);
      if (out === null) {
        // Another pass owns the ledger. Reported rather than returned as an
        // empty result, because "nothing to do" and "not allowed to look" are
        // very different answers and they used to be indistinguishable.
        const today = this.today();
        return {
          ranAt: this.cfg.clock.now(), today, considered: 0, actions: [],
          fastCount: 0, slowCount: 0, sentCount: 0, blockedCount: 0, lockHeld: true,
        };
      }
      return out;
    }
    return this.#tick();
  }

  async #tick(): Promise<TickReport> {
    const now = this.cfg.clock.now();
    const today = this.today();
    const actions: TickAction[] = [];

    const ledger = await this.cfg.store.load(this.cfg.policy);
    ledger.refreshAll(today);

    for (const inv of ledger.openInvoices()) {
      const c = ledger.caseFile(inv.id, now);
      const r = route(c);

      let decision: Decision;
      // Checked ahead of routing. Calling is triggered by a buyer having gone
      // quiet, and a quiet case is exactly what the router sends to the agent,
      // so a call decided only on the fast path never happens on the cases it
      // is for. It stays a rule rather than a tool the model may reach for:
      // this is the most intrusive thing the system does.
      const call = voiceCall(c);
      if (call) {
        decision = { action: call.action, rationale: call.rationale, confidence: 1, actor: "fast", ...(call.nextReviewAt ? { nextReviewAt: call.nextReviewAt } : {}) };
      } else if (r.route === "slow" && this.cfg.llm) {
        const res = await runCaseAgent(this.cfg.llm, c, now, this.cfg.agent);
        decision = res.decision;
      } else {
        const fp = fastPath(c, (rung, persona) => templateDraft(c, rung, persona));
        decision = { action: fp.action, rationale: fp.rationale, confidence: 1, actor: "fast", ...(fp.nextReviewAt ? { nextReviewAt: fp.nextReviewAt } : {}) };
      }

      const entry: TickAction = {
        invoiceId: inv.id, buyer: c.buyer.name,
        route: r.route, routeReason: r.reason,
        action: decision.action, rationale: decision.rationale,
        guards: [], applied: false,
      };

      const verdict = runGuards(c, decision.action, now);
      entry.guards = verdict.results;

      if (!verdict.allowed) {
        entry.blocked = verdict.violation ?? "guard refused";
        // A refusal is a decision, and it was going unrecorded. Two things
        // followed. The audit trail did not show the guards doing the one job
        // the whole layer exists for, and with no standing decision written the
        // case proposed the identical action on the next tick, was refused
        // again, and never settled.
        ledger.audit.append({
          ts: now, invoiceId: inv.id, actor: decision.actor, action: decision.action.kind,
          params: {
            refusedBy: verdict.results.filter((g) => !g.pass).map((g) => g.name),
            nextReviewAt: decision.nextReviewAt ?? addDays(today, 1),
          },
          rationale: `${decision.rationale} The guards refused it: ${verdict.violation}`,
          guards: verdict.results,
          policyVersion: this.cfg.policy.policyVersion,
          evidence: [inv.id],
        });
        actions.push(entry);
        continue;
      }

      try {
        // Hold the invoice while acting. A payment webhook landing between the
        // decision and the send is exactly the case the guards cannot catch,
        // because they already ran.
        const act = async () => {
          const fresh = this.cfg.store.load(this.cfg.policy);
          const l = fresh instanceof Promise ? await fresh : fresh;
          const recheck = l.caseFile(inv.id, now);
          if (recheck.invoice.substate === "paid" || recheck.invoice.substate === "closed") {
            entry.blocked = "settled while this pass was deciding";
            return undefined;
          }
          const sent = await this.apply(ledger, c.invoice.id, decision, now);
          entry.applied = true;
          return sent;
        };
        const sent = this.#locks
          ? await this.#locks.tryWith(invoiceLock(inv.id), act)
          : await act();
        if (sent) entry.sent = sent;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        entry.error = why;
        // A failure that leaves no record is a failure the loop repeats. The
        // case would come back tomorrow with the identical state, take the
        // identical decision and fail the identical way, forever. Writing the
        // attempt down with a review date turns a hot loop into a retry.
        try {
          ledger.audit.append({
            ts: now, invoiceId: inv.id, actor: decision.actor, action: decision.action.kind,
            params: { failed: why, nextReviewAt: addDays(today, 1) },
            rationale: `${decision.rationale} This did not go through: ${why}. Trying again tomorrow rather than on the next pass.`,
            guards: entry.guards, policyVersion: this.cfg.policy.policyVersion,
            evidence: [inv.id],
          });
        } catch {
          // The audit log is strict about rationale and evidence. If it will
          // not take the entry there is nothing further to do here.
        }
      }
      actions.push(entry);
    }

    await this.cfg.store.save(ledger);

    return {
      ranAt: now, today,
      considered: actions.length,
      actions,
      fastCount: actions.filter((a) => a.route === "fast").length,
      slowCount: actions.filter((a) => a.route === "slow").length,
      sentCount: actions.filter((a) => a.sent).length,
      blockedCount: actions.filter((a) => a.blocked).length,
    };
  }

  /** Applies one approved action, sending for real when the action is a nudge. */
  private async apply(
    ledger: Ledger, invoiceId: string, decision: Decision, now: number,
  ): Promise<TickAction["sent"] | undefined> {
    const c = ledger.caseFile(invoiceId, now);
    const a = decision.action;
    const today = istParts(now).date;
    // The standing decision. Without it on the entry the router has nothing to
    // read back, so it re-asks the same question every tick and the case never
    // settles. The simulator has always recorded this; the live path did not,
    // which made every deployed decision non-sticky.
    const review = decision.nextReviewAt ? { nextReviewAt: decision.nextReviewAt } : {};

    switch (a.kind) {
      case "none":
        // A no-op is still a decision, and it is the one most in need of a
        // review date: it is what holds a quiet case quiet. But only when it
        // says something new. Re-recording an unchanged review date once a day
        // turned a six-week case into sixty near-identical rows and buried the
        // days that mattered.
        if (decision.nextReviewAt && decision.nextReviewAt !== c.nextReviewOn) {
          ledger.audit.append({
            ts: now, invoiceId, actor: decision.actor, action: "none",
            params: { reason: a.reason, ...review }, rationale: decision.rationale,
            guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [invoiceId],
          });
        }
        return undefined;

      case "schedule_wait":
        // Only when the date moves. Re-recording the same promise every day
        // says nothing and hides the day it was made.
        if (decision.nextReviewAt !== c.nextReviewOn) {
          ledger.audit.append({
            ts: now, invoiceId, actor: decision.actor, action: "schedule_wait",
            params: { until: a.until, reason: a.reason, ...review }, rationale: decision.rationale,
            guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [invoiceId],
          });
        }
        return undefined;

      case "open_dispute":
        // A dispute is opened once. Re-opening an open one is not an event.
        if (c.invoice.substate !== "disputed") {
          ledger.setSubstate(invoiceId, "disputed", decision.rationale,
            decision.actor === "agent" ? "agent" : "fast", [invoiceId], { disputeReason: a.reason, ...review });
        }
        return undefined;

      case "escalate_to_human":
        ledger.setSubstate(invoiceId, "human_hold", decision.rationale,
          decision.actor === "agent" ? "agent" : "fast", [invoiceId], review);
        return undefined;

      case "stop":
        ledger.setSubstate(invoiceId, "closed", decision.rationale,
          decision.actor === "agent" ? "agent" : "fast", [invoiceId],
          { closedOn: today, closedReason: a.reason });
        return undefined;

      case "reissue_payment_path":
        await this.reissue(ledger, invoiceId, decision.rationale, now);
        return undefined;

      case "deliver_invoice":
        // Delivery happens once, at creation, and is recorded there. The tick
        // never proposes it.
        return undefined;

      case "place_call": {
        // Reissue first when the link is dead. The buyer will be told on the
        // call that a link is coming, and it needs to be a live one.
        if (!ledger.linkIsLive(c.invoice, today)) {
          await this.reissue(ledger, invoiceId,
            `Payment link expired on ${c.invoice.linkExpiresOn}. Reissuing before the call so the buyer can be sent a live path during it.`, now);
        }
        let outcome: { sid: string; status: string; dryRun?: boolean } | null = null;
        let failure: string | null = null;
        try {
          outcome = this.cfg.voice
            ? await this.cfg.voice.placeCall({ to: c.buyer.phone, invoiceId, buyerName: c.buyer.name })
            : null;
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        }
        ledger.audit.append({
          ts: now, invoiceId, actor: decision.actor, action: "place_call",
          params: {
            reason: a.reason, to: c.buyer.phone, ...review,
            ...(outcome ? { callSid: outcome.sid, status: outcome.status } : {}),
            ...(failure ? { failed: failure } : {}),
            ...(this.cfg.voice ? {} : { failed: "no voice caller configured" }),
          },
          rationale: failure
            ? `${decision.rationale} The call could not be placed: ${failure}`
            : decision.rationale,
          guards: runGuards(c, a, now).results,
          policyVersion: this.cfg.policy.policyVersion,
          evidence: [outcome?.sid, invoiceId].filter(Boolean) as string[],
        });
        return outcome ? { messageId: outcome.sid, template: null, dryRun: outcome.dryRun ?? false } : undefined;
      }

      case "send_nudge": {
        // The last rung is the one with record value: it is the message a buyer
        // forwards to their accounts team and the one quoted back later. So it
        // goes out on both channels, as a fresh link Razorpay emails and a
        // WhatsApp carrying the same link. One touch, two channels: the budget
        // counts messages the buyer did not ask for, not envelopes.
        const finalRung = a.rung === this.cfg.policy.ladder[this.cfg.policy.ladder.length - 2];
        let emailed = false;

        if (finalRung || a.rung === "whatsapp+reissue" || !ledger.linkIsLive(c.invoice, today)) {
          emailed = await this.reissue(ledger, invoiceId,
            finalRung
              ? "Final notice. Issuing a fresh link so the closing message carries a live path on both channels."
              : `The payment link expired on ${c.invoice.linkExpiresOn}. Reissuing before the nudge so the message carries a live path.`,
            now,
            { email: finalRung },
          );
        }
        const fresh = ledger.caseFile(invoiceId, now);
        const sent = await this.send(fresh.invoice, fresh.buyer.phone, fresh.buyer.name, a, ledger);

        // Every follow-up rides all three channels: our WhatsApp, and
        // Razorpay's own email and SMS for the same invoice. One decision, one
        // touch against the budget, three envelopes. Razorpay is the sender of
        // record for the email and SMS, which is exactly what makes them worth
        // sending: its reminder carries the payment page and its name.
        let smsed = false;
        const extRefs = ledger.external(invoiceId);
        if (this.cfg.razorpay && extRefs?.razorpayInvoiceId && fresh.invoice.substate !== "paid") {
          try {
            await this.cfg.razorpay.notifyInvoice(extRefs.razorpayInvoiceId, "email");
            emailed = true;
          } catch { /* recorded below as what actually went */ }
          try {
            await this.cfg.razorpay.notifyInvoice(extRefs.razorpayInvoiceId, "sms");
            smsed = true;
          } catch { /* same */ }
        }

        ledger.recordTouch(
          {
            invoiceId, buyerId: fresh.buyer.id, ts: now,
            channel: "whatsapp", persona: a.persona, rung: a.rung,
            carriedLiveLink: ledger.linkIsLive(fresh.invoice, today),
            body: a.draft,
            ...(emailed ? { emailed: true } : {}),
            ...(smsed ? { smsed: true } : {}),
          },
          runGuards(fresh, a, now).results,
          decision.rationale,
          decision.actor === "agent" ? "agent" : "fast",
          review,
        );
        return sent;
      }
    }
  }

  private async reissue(
    ledger: Ledger, invoiceId: string, rationale: string, now: number,
    opts: { email?: boolean } = {},
  ): Promise<boolean> {
    const c = ledger.caseFile(invoiceId, now);
    const today = istParts(now).date;
    const validDays = 14;
    const email = Boolean(opts.email && c.buyer.email);

    if (this.cfg.razorpay) {
      let link: { id: string; short_url: string };
      try {
        // A fresh Razorpay Invoice, matching how the original was issued.
        // Payment links were the old path here and are capped far lower, so a
        // book of any size ran out of them and every reissue after that failed:
        // the one repair that the ablation says most of the margin comes from.
        const customerId = ledger.external(invoiceId)?.razorpayCustomerId
          ?? (await this.cfg.razorpay.createCustomer({
            name: c.buyer.name,
            contact: `+${c.buyer.phone}`,
            ...(c.buyer.email ? { email: c.buyer.email } : {}),
          })).id;
        link = await this.cfg.razorpay.createInvoice({
          customerId,
          amount: c.invoice.amount - c.invoice.amountPaid,
          description: `Invoice ${c.invoice.id} (reissued)`,
          receipt: `baaki_reissue_${c.invoice.id}_${Date.now()}`,
          // Each reissue overwrites the stored id, so without this a payment
          // on any earlier generation of the link matched nothing and the
          // money sat unclaimed. The notes name the ledger invoice no matter
          // which generation gets paid.
          notes: { baaki_invoice_id: invoiceId },
          expireBy: Math.floor(Math.max(
            Date.parse(`${addDays(today, validDays)}T18:00:00+05:30`),
            Date.now() + 30 * 60_000,
          ) / 1000),
          notify: { email, sms: false },
        });
      } catch (e) {
        // A provider that will not mint a fresh link is not a reason for the
        // buyer to hear nothing. Record why the path is stale and let the
        // message go with the link there is. Throwing here meant one exhausted
        // quota silently stopped every nudge on the book, and because the touch
        // was never recorded the same action retried on every tick forever.
        const why = e instanceof Error ? e.message : String(e);
        ledger.audit.append({
          ts: now, invoiceId, actor: "fast", action: "reissue_payment_path",
          params: { failed: why },
          rationale: `Could not issue a fresh payment path: ${why}. The message still goes out, carrying the existing link.`,
          guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [invoiceId],
        });
        return false;
      }
      const inv = ledger.invoice(invoiceId);
      inv.linkExpiresOn = addDays(today, validDays);
      ledger.noteExternal(invoiceId, { razorpayInvoiceId: link.id, shortUrl: link.short_url });
      ledger.audit.append({
        ts: now, invoiceId, actor: "agent", action: "reissue_payment_path",
        params: { paymentLinkId: link.id, shortUrl: link.short_url, expireBy: inv.linkExpiresOn, emailed: email },
        rationale: email ? `${rationale} Razorpay emailed the fresh link to ${c.buyer.email}.` : rationale,
        guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [link.id],
      });
      return email;
    }
    ledger.reissuePaymentPath(invoiceId, today, validDays, rationale, "agent");
    return false;
  }

  /**
   * Whether Meta's 24-hour session window is open for this invoice's buyer.
   *
   * Two mistakes lived here. The window was measured with the ledger clock,
   * and on a moved calendar an hour-old real reply looked weeks stale, so
   * follow-ups fell back to a bare template while a genuine window stood open.
   * And promises captured on phone calls are recorded as replies, but a phone
   * call does not open a WhatsApp window; counting one made sends that Meta
   * would refuse. Wall clock, genuine inbound WhatsApp only.
   */
  static waSessionOpen(replies: readonly { channel: string; text: string; ts: number }[]): boolean {
    const last = [...replies].reverse().find(
      (r) => r.channel === "whatsapp" && !r.text.startsWith("[voice call]"),
    );
    return last ? Date.now() - last.ts <= 24 * 3600_000 : false;
  }

  /**
   * A promise made on the phone, put in writing.
   *
   * A date agreed out loud is the least durable thing in this system: nobody
   * can look it up, and the buyer has nothing showing what they agreed to or
   * how to pay. So the moment a call records one, the same thing goes out as a
   * message with a live link. It is not a nudge and does not spend the touch
   * budget: it is a receipt for something the buyer just said.
   */
  async confirmPromise(invoiceId: string, promisedFor: string): Promise<{ sent: boolean; detail: string }> {
    const now = this.cfg.clock.now();
    const ledger = await this.cfg.store.load(this.cfg.policy);
    let c;
    try { c = ledger.caseFile(invoiceId, now); } catch { return { sent: false, detail: "unknown invoice" }; }
    if (c.memory.doNotContact) return { sent: false, detail: "buyer is on do_not_contact" };
    if (!this.cfg.whatsapp) return { sent: false, detail: "whatsapp is not configured" };

    // Make sure the link they are being sent actually works.
    if (!ledger.linkIsLive(c.invoice, istParts(now).date)) {
      await this.cfg.store.update(async (l) => {
        await this.reissue(l, invoiceId, "Promise taken on a call. Issuing a live link to send with the confirmation.", now, { email: true });
        return null;
      }, this.cfg.policy);
    }

    const fresh = (await this.cfg.store.load(this.cfg.policy)).caseFile(invoiceId, now);
    const shortUrl = (await this.cfg.store.load(this.cfg.policy)).external(invoiceId)?.shortUrl ?? "";
    const text = `Namaste ${fresh.buyer.name}, abhi call par baat hui. Aapne ${formatCivilShort(promisedFor)} tak ${formatINR(fresh.invoice.amount - fresh.invoice.amountPaid)} ka payment karne ko kaha hai, maine note kar liya hai. Tab tak koi reminder nahi bhejenge.${shortUrl ? `\n\nPayment link: ${shortUrl}` : ""}`;

    // The buyer spoke to us on the phone, which does not open a WhatsApp
    // session window: only an inbound WhatsApp message does. So this goes as
    // free-form when a window is open and as a template otherwise.
    const inSession = Baaki.waSessionOpen(fresh.replies);

    try {
      if (inSession) {
        const res = await this.cfg.whatsapp.sendText(fresh.buyer.phone, text);
        await this.#recordConfirmation(invoiceId, promisedFor, res.messageId, shortUrl);
        return { sent: true, detail: `confirmation sent (${res.messageId})` };
      }
      const usable = await this.usableTemplate(RUNG_TEMPLATE.whatsapp!);
      if (!usable) return { sent: false, detail: "no approved template available" };
      const res = usable.isFallback
        ? await this.cfg.whatsapp.sendTemplate({ to: fresh.buyer.phone, template: usable.template, language: "en_US", bodyParams: [] })
        : await this.cfg.whatsapp.sendTemplate({
            to: fresh.buyer.phone, template: usable.template, language: "en",
            bodyParams: [
              fresh.buyer.name, invoiceId,
              formatINR(fresh.invoice.amount - fresh.invoice.amountPaid).replace("₹", "Rs "),
              formatCivilShort(promisedFor),
            ],
            ...(shortUrl ? { urlButtonSuffix: shortUrl.split("/").pop() ?? "" } : {}),
          });
      await this.#recordConfirmation(invoiceId, promisedFor, res.messageId, shortUrl);
      return { sent: true, detail: `confirmation sent (${res.messageId})` };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await this.#recordConfirmation(invoiceId, promisedFor, null, shortUrl, why);
      return { sent: false, detail: why };
    }
  }

  async #recordConfirmation(invoiceId: string, promisedFor: string, messageId: string | null, shortUrl: string, failed?: string): Promise<void> {
    await this.cfg.store.update((ledger) => {
      ledger.audit.append({
        ts: this.cfg.clock.now(), invoiceId, actor: "agent", action: "none",
        params: { confirmation: "promise", promisedFor, messageId, ...(failed ? { failed } : {}) },
        rationale: failed
          ? `Could not put the promise of ${formatCivilShort(promisedFor)} in writing: ${failed}`
          : `Promise of ${formatCivilShort(promisedFor)} taken on the call and confirmed in writing, with a live payment link. Not a reminder, so it does not spend the touch budget.`,
        guards: [], policyVersion: this.cfg.policy.policyVersion,
        evidence: [messageId, shortUrl, invoiceId].filter(Boolean) as string[],
      });
      return null;
    }, this.cfg.policy);
  }

  /**
   * The template Meta will actually accept right now.
   *
   * A template still in review cannot be sent, and failing the send over it
   * means the buyer hears nothing at all. Falling back to an approved opener
   * gets a conversation started, and once the buyer replies the 24-hour window
   * opens and the real message can go as free-form.
   *
   * Shared by every send path. It used to live only in the nudge path, so the
   * delivery path went out with an unapproved template and failed outright.
   */
  private async usableTemplate(intended: string): Promise<{ template: string; isFallback: boolean } | null> {
    if (!this.cfg.wabaId || !this.cfg.whatsapp) return { template: intended, isFallback: false };
    try {
      const approved = await this.cfg.whatsapp.approvedTemplates(this.cfg.wabaId);
      if (approved.has(intended)) return { template: intended, isFallback: false };
      const opener = ["hello_world"].find((t) => approved.has(t));
      return opener ? { template: opener, isFallback: true } : null;
    } catch {
      // Could not check. Try the intended one and let the send report.
      return { template: intended, isFallback: false };
    }
  }

  /**
   * Template outside the session window, free-form inside it. The guard has
   * already decided which is legal; this picks the mechanism to match.
   */
  private async send(
    invoice: Invoice, phone: string, name: string,
    a: Extract<Action, { kind: "send_nudge" }>, ledger: Ledger,
  ): Promise<TickAction["sent"] | undefined> {
    if (!this.cfg.whatsapp) return undefined;

    const ext = ledger.external(invoice.id);
    const shortUrl = ext?.shortUrl ?? "";
    const suffix = shortUrl.split("/").pop() ?? "";
    const outstanding = invoice.amount - invoice.amountPaid;

    const inSession = Baaki.waSessionOpen(ledger.repliesFor(invoice.id));

    if (inSession) {
      const res = await this.cfg.whatsapp.sendText(phone, `${a.draft}${shortUrl ? `\n\n${shortUrl}` : ""}`);
      return { messageId: res.messageId, template: null, dryRun: res.dryRun };
    }

    const template = RUNG_TEMPLATE[a.rung];
    if (!template) return undefined;

    const usable = await this.usableTemplate(template);
    if (!usable) return undefined;

    if (usable.isFallback) {
      // hello_world takes no parameters and is en_US only.
      const res = await this.cfg.whatsapp.sendTemplate({ to: phone, template: usable.template, language: "en_US", bodyParams: [] });
      return { messageId: res.messageId, template: usable.template, dryRun: res.dryRun };
    }

    const bodyParams = a.rung === "owner_whatsapp"
      ? [name, invoice.id, formatINR(outstanding).replace("₹", "Rs "), String(Math.max(0, Math.round((Date.parse(this.today() + "T00:00:00Z") - Date.parse(invoice.dueOn + "T00:00:00Z")) / 86400000)))]
      : [name, invoice.id, formatINR(outstanding).replace("₹", "Rs "), formatCivilShort(invoice.dueOn)];

    const res = await this.cfg.whatsapp.sendTemplate({
      to: phone, template, language: "en", bodyParams,
      ...(suffix ? { urlButtonSuffix: suffix } : {}),
    });
    return { messageId: res.messageId, template, dryRun: res.dryRun };
  }

  // -- inbound ---------------------------------------------------------------

  /** Razorpay tells us money moved. Nothing else is allowed to say so. */
  async handleRazorpayWebhook(rawBody: string, signature: string | undefined): Promise<{ ok: boolean; reason?: string; event?: RzpEvent }> {
    if (!this.cfg.razorpay) return { ok: false, reason: "razorpay not configured" };
    if (!this.cfg.razorpay.verifyWebhook(rawBody, signature)) {
      return { ok: false, reason: "bad signature" };
    }
    const ev = parseRzpEvent(JSON.parse(rawBody));

    // Razorpay retries until it gets a 2xx, so the same event arrives more than
    // once as a matter of course. Recording a payment twice would double the
    // amount paid.
    if (this.#locks && !(await this.#locks.firstSeen("razorpay", ev.id))) {
      return { ok: true, event: ev };
    }

    const applyEvent = () => this.cfg.store.update((ledger) => {
      const invoiceId = this.matchInvoice(ledger, ev);
      if (!invoiceId) return;

      const paidEvents = ["invoice.paid", "payment_link.paid", "payment.captured", "virtual_account.credited", "invoice.partially_paid"];
      if (paidEvents.includes(ev.event) && ev.amount) {
        ledger.recordPayment({ invoiceId, ts: ev.createdAt, amount: ev.amount, evidence: ev.id });
      } else if (ev.event === "invoice.expired" || ev.event === "payment_link.expired") {
        const inv = ledger.invoice(invoiceId);
        inv.linkExpiresOn = istParts(ev.createdAt).date;
        ledger.audit.append({
          ts: ev.createdAt, invoiceId, actor: "webhook", action: "none",
          params: { event: ev.event },
          rationale: "The payment path expired. The next nudge must reissue before it can carry a live link.",
          guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [ev.id],
        });
      }
    }, this.cfg.policy);

    // Match the invoice outside the lock, then hold it while writing.
    const target = await this.#matchForEvent(ev);
    if (this.#locks && target) {
      await this.#locks.with(invoiceLock(target), applyEvent, 15_000);
    } else {
      await applyEvent();
    }

    return { ok: true, event: ev };
  }

  /** Which invoice an event belongs to, read without holding a lock. */
  async #matchForEvent(ev: RzpEvent): Promise<string | null> {
    const l = await this.cfg.store.load(this.cfg.policy);
    return this.matchInvoice(l, ev);
  }

  private matchInvoice(ledger: Ledger, ev: RzpEvent): string | null {
    for (const inv of ledger.invoices()) {
      const ext = ledger.external(inv.id);
      if (!ext) continue;
      if (ev.paymentLinkId && ext.razorpayPaymentLinkId === ev.paymentLinkId) return inv.id;
      if (ev.invoiceId && ext.razorpayInvoiceId === ev.invoiceId) return inv.id;
      if (ev.virtualAccountId && ext.virtualAccountId === ev.virtualAccountId) return inv.id;
    }
    // The notes name the ledger invoice directly, surviving any number of
    // reissues overwriting the stored id.
    const direct = ev.notes?.baaki_invoice_id;
    if (direct) {
      try { if (ledger.invoice(direct)) return direct; } catch { /* stale note */ }
    }
    // Fall back to the notes we set when creating the link.
    const cid = ev.notes?.baaki_contact_id;
    if (cid) {
      const open = ledger.openInvoices().filter((i) => i.buyerId === cid);
      if (open.length === 1) return open[0]!.id;
    }
    return null;
  }

  /**
   * A buyer replied. Buttons carry their meaning exactly; free text goes to the
   * model. A parse below the confidence threshold is recorded as unclear and
   * the router sends the case to judgment rather than acting on a guess.
   */
  async handleWhatsappWebhook(rawBody: string, signature: string | undefined): Promise<{ ok: boolean; reason?: string; handled: number }> {
    if (!this.cfg.whatsapp) return { ok: false, reason: "whatsapp not configured", handled: 0 };
    if (!this.cfg.whatsapp.verifySignature(rawBody, signature)) {
      return { ok: false, reason: "bad signature", handled: 0 };
    }

    const { messages } = parseWebhook(JSON.parse(rawBody));
    let handled = 0;

    for (const m of messages) {
      // Meta redelivers on anything but a fast 2xx; the wamid makes each
      // message exactly once.
      if (this.#locks && !(await this.#locks.firstSeen("whatsapp", m.messageId))) continue;

      const target = await this.cfg.store.update((ledger) => {
        const buyer = ledger.buyersList().find((b) => b.phone.replace(/\D/g, "") === m.from.replace(/\D/g, ""));
        if (!buyer) return null;
        const open = ledger.openInvoices().filter((i) => i.buyerId === buyer.id)
          .sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
        return open.length ? { invoiceId: open[0]!.id, buyerId: buyer.id, buyerName: buyer.name } : null;
      }, this.cfg.policy);

      if (!target) continue;

      let intent: string, promiseDate: CivilDate | undefined, disputeReason: string | undefined, confidence: number;

      if (m.source === "button") {
        intent = buttonIntent(m.buttonPayload ?? m.text);
        confidence = 1;
      } else if (isOptOut(m.text)) {
        intent = "stop";
        confidence = 1;
      } else if (this.cfg.llm) {
        const parsed = await understandReply(this.cfg.llm, m.text, {
          today: this.today(), buyerName: target.buyerName, invoiceId: target.invoiceId,
        });
        intent = parsed.intent;
        promiseDate = parsed.promiseDate;
        disputeReason = parsed.disputeReason;
        confidence = parsed.confidence;
      } else {
        intent = "unclear";
        confidence = 0;
      }

      await this.cfg.store.update((ledger) => {
        ledger.recordReply({
          invoiceId: target.invoiceId, buyerId: target.buyerId, ts: m.timestamp,
          channel: "whatsapp", source: m.source, text: m.text,
          intent: intent as never, promiseDate, disputeReason, confidence,
        });
      }, this.cfg.policy);

      handled += 1;
      if (this.cfg.whatsapp.config.dryRun !== true) {
        await this.cfg.whatsapp.markRead(m.messageId).catch(() => {});
      }
    }

    return { ok: true, handled };
  }

  /**
   * A buyer replied by email.
   *
   * Same pipeline as a WhatsApp reply: the text is read by the model, a
   * promise freezes outreach, a dispute stops it, an opt-out is permanent.
   * Matching is by the sender's address against the buyer on file, which is
   * the address Razorpay has been invoicing, so a reply from anywhere else is
   * deliberately ignored rather than guessed at.
   */
  async handleInboundEmail(input: {
    from: string; subject?: string; text: string; messageId?: string;
  }): Promise<{ ok: boolean; reason?: string; invoiceId?: string; intent?: string }> {
    const addr = extractAddress(input.from);
    const text = extractReplyText(input.text);
    if (!addr || !text) return { ok: false, reason: "nothing to read" };

    // Providers redeliver on slow responses, same as Meta and Razorpay.
    const dedupeKey = input.messageId ?? `${addr}:${text.slice(0, 80)}`;
    if (this.#locks && !(await this.#locks.firstSeen("email", dedupeKey))) {
      return { ok: true, reason: "duplicate" };
    }

    const target = await this.cfg.store.update((ledger) => {
      const buyer = ledger.buyersList().find((b) => (b.email ?? "").toLowerCase() === addr);
      if (!buyer) return null;
      const open = ledger.openInvoices().filter((i) => i.buyerId === buyer.id)
        .sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
      return open.length ? { invoiceId: open[0]!.id, buyerId: buyer.id, buyerName: buyer.name } : null;
    }, this.cfg.policy);
    if (!target) return { ok: false, reason: `no open invoice for ${addr}` };

    let intent: string, promiseDate: CivilDate | undefined, disputeReason: string | undefined, confidence: number;
    if (isOptOut(text)) {
      intent = "stop"; confidence = 1;
    } else if (this.cfg.llm) {
      const parsed = await understandReply(this.cfg.llm, text, {
        today: this.today(), buyerName: target.buyerName, invoiceId: target.invoiceId,
      });
      intent = parsed.intent;
      promiseDate = parsed.promiseDate;
      disputeReason = parsed.disputeReason;
      confidence = parsed.confidence;
    } else {
      intent = "unclear"; confidence = 0;
    }

    await this.cfg.store.update((ledger) => {
      ledger.recordReply({
        invoiceId: target.invoiceId, buyerId: target.buyerId, ts: this.cfg.clock.now(),
        channel: "email", source: "free_text", text,
        intent: intent as never, promiseDate, disputeReason, confidence,
      });
    }, this.cfg.policy);

    return { ok: true, invoiceId: target.invoiceId, intent };
  }

  async auditExport(format: "json" | "csv"): Promise<string> {
    const l = await this.cfg.store.load(this.cfg.policy);
    return format === "csv" ? l.audit.export("csv") : l.audit.export("json");
  }

  async auditEntries(): Promise<readonly AuditEntry[]> {
    return (await this.cfg.store.load(this.cfg.policy)).audit.all();
  }
}
