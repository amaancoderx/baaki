import { runCaseAgent, type AgentOptions } from "./agent/index.js";
import type { AuditEntry, GuardResult } from "./audit.js";
import { buttonIntent, isOptOut, parseWebhook, type WhatsappClient } from "./channels/whatsapp.js";
import type { Contact } from "./contacts.js";
import { runGuards } from "./guards/index.js";
import type { Ledger } from "./ledger.js";
import type { Llm } from "./llm/types.js";
import { formatINR, type Paise } from "./money.js";
import { fastPath } from "./policy.js";
import { parseRzpEvent, type RazorpayClient, type RzpEvent } from "./razorpay/index.js";
import { route } from "./router.js";
import type { LedgerStoreLike } from "./store.js";
import { addDays, formatCivilShort, istParts, type Clock, type CivilDate } from "./time.js";
import { templateDraft } from "./drafts.js";
import { understandReply } from "./understand.js";
import type { Action, Buyer, Decision, Invoice, Policy, Rung } from "./types.js";

/** Which approved template carries which rung. */
export const RUNG_TEMPLATE: Record<Rung, string | null> = {
  pre_due: "baaki_predue_reminder",
  whatsapp: "baaki_invoice_reminder",
  "whatsapp+reissue": "baaki_invoice_reminder",
  owner_whatsapp: "baaki_owner_followup",
  human: null,
};

export interface BaakiConfig {
  store: LedgerStoreLike;
  policy: Policy;
  razorpay?: RazorpayClient;
  whatsapp?: WhatsappClient;
  llm?: Llm;
  agent?: AgentOptions;
  clock: Clock;
  /** Set when the payment link should be shortened for the template button. */
  linkBase?: string;
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

export interface CreatedInvoice {
  invoice: Invoice;
  razorpay?: {
    customerId: string;
    invoiceId?: string;
    paymentLinkId?: string;
    shortUrl?: string;
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
  constructor(private readonly cfg: BaakiConfig) {}

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
    const expireBy = Math.floor(Date.parse(`${addDays(today, linkValidDays)}T18:00:00+05:30`) / 1000);

    let rzp: CreatedInvoice["razorpay"];

    if (this.cfg.razorpay) {
      const customer = await this.cfg.razorpay.createCustomer({
        name: input.contact.name,
        contact: input.contact.phone,
        ...(input.contact.email ? { email: input.contact.email } : {}),
        notes: { baaki_contact_id: input.contact.id, city: input.contact.city },
      });

      const link = await this.cfg.razorpay.createPaymentLink({
        amount: input.amount,
        description: input.description,
        customer: {
          name: input.contact.name,
          contact: `+${input.contact.phone}`,
          ...(input.contact.email ? { email: input.contact.email } : {}),
        },
        expireBy,
        referenceId: `baaki_${Date.now()}`,
        notes: { baaki_contact_id: input.contact.id },
      });

      rzp = { customerId: customer.id, paymentLinkId: link.id, shortUrl: link.short_url };

      if (input.createVirtualAccount) {
        try {
          const va = await this.cfg.razorpay.createVirtualAccount({
            customerId: customer.id,
            description: `Baaki collections — ${input.contact.name}`,
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
      const buyer: Buyer = { id: input.contact.id, name: input.contact.name, phone: input.contact.phone };
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

    return { invoice: created, razorpay: rzp };
  }

  // -- the loop --------------------------------------------------------------

  async tick(): Promise<TickReport> {
    const now = this.cfg.clock.now();
    const today = this.today();
    const actions: TickAction[] = [];

    const ledger = await this.cfg.store.load(this.cfg.policy);
    ledger.refreshAll(today);

    for (const inv of ledger.openInvoices()) {
      const c = ledger.caseFile(inv.id, now);
      const r = route(c);

      let decision: Decision;
      if (r.route === "slow" && this.cfg.llm) {
        const res = await runCaseAgent(this.cfg.llm, c, now, this.cfg.agent);
        decision = res.decision;
      } else {
        const fp = fastPath(c, (rung, persona) => templateDraft(c, rung, persona));
        decision = { action: fp.action, rationale: fp.rationale, confidence: 1, actor: "fast" };
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
        actions.push(entry);
        continue;
      }

      try {
        const sent = await this.apply(ledger, c.invoice.id, decision, now);
        entry.applied = true;
        if (sent) entry.sent = sent;
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
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

    switch (a.kind) {
      case "none":
        return undefined;

      case "schedule_wait":
        ledger.audit.append({
          ts: now, invoiceId, actor: decision.actor, action: "schedule_wait",
          params: { until: a.until, reason: a.reason }, rationale: decision.rationale,
          guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [invoiceId],
        });
        return undefined;

      case "open_dispute":
        ledger.setSubstate(invoiceId, "disputed", decision.rationale,
          decision.actor === "agent" ? "agent" : "fast", [invoiceId], { disputeReason: a.reason });
        return undefined;

      case "escalate_to_human":
        ledger.setSubstate(invoiceId, "human_hold", decision.rationale,
          decision.actor === "agent" ? "agent" : "fast", [invoiceId]);
        return undefined;

      case "stop":
        ledger.setSubstate(invoiceId, "closed", decision.rationale,
          decision.actor === "agent" ? "agent" : "fast", [invoiceId],
          { closedOn: today, closedReason: a.reason });
        return undefined;

      case "reissue_payment_path":
        await this.reissue(ledger, invoiceId, decision.rationale, now);
        return undefined;

      case "send_nudge": {
        if (a.rung === "whatsapp+reissue" || !ledger.linkIsLive(c.invoice, today)) {
          await this.reissue(ledger, invoiceId,
            `The payment link expired on ${c.invoice.linkExpiresOn}. Reissuing before the nudge so the message carries a live path.`, now);
        }
        const fresh = ledger.caseFile(invoiceId, now);
        const sent = await this.send(fresh.invoice, fresh.buyer.phone, fresh.buyer.name, a, ledger);
        ledger.recordTouch(
          {
            invoiceId, buyerId: fresh.buyer.id, ts: now,
            channel: "whatsapp", persona: a.persona, rung: a.rung,
            carriedLiveLink: ledger.linkIsLive(fresh.invoice, today),
            body: a.draft,
          },
          runGuards(fresh, a, now).results,
          decision.rationale,
          decision.actor === "agent" ? "agent" : "fast",
        );
        return sent;
      }
    }
  }

  private async reissue(ledger: Ledger, invoiceId: string, rationale: string, now: number): Promise<void> {
    const c = ledger.caseFile(invoiceId, now);
    const today = istParts(now).date;
    const validDays = 14;

    if (this.cfg.razorpay) {
      const link = await this.cfg.razorpay.createPaymentLink({
        amount: c.invoice.amount - c.invoice.amountPaid,
        description: `Invoice ${c.invoice.id} (reissued)`,
        customer: { name: c.buyer.name, contact: `+${c.buyer.phone}` },
        expireBy: Math.floor(Date.parse(`${addDays(today, validDays)}T18:00:00+05:30`) / 1000),
        referenceId: `baaki_reissue_${c.invoice.id}_${Date.now()}`,
      });
      const inv = ledger.invoice(invoiceId);
      inv.linkExpiresOn = addDays(today, validDays);
      ledger.noteExternal(invoiceId, { razorpayPaymentLinkId: link.id, shortUrl: link.short_url });
      ledger.audit.append({
        ts: now, invoiceId, actor: "agent", action: "reissue_payment_path",
        params: { paymentLinkId: link.id, shortUrl: link.short_url, expireBy: inv.linkExpiresOn },
        rationale, guards: [], policyVersion: this.cfg.policy.policyVersion, evidence: [link.id],
      });
    } else {
      ledger.reissuePaymentPath(invoiceId, today, validDays, rationale, "agent");
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

    const lastReply = ledger.repliesFor(invoice.id).at(-1);
    const inSession = lastReply ? this.cfg.clock.now() - lastReply.ts <= 24 * 3600_000 : false;

    if (inSession) {
      const res = await this.cfg.whatsapp.sendText(phone, `${a.draft}${shortUrl ? `\n\n${shortUrl}` : ""}`);
      return { messageId: res.messageId, template: null, dryRun: res.dryRun };
    }

    const template = RUNG_TEMPLATE[a.rung];
    if (!template) return undefined;

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

    await this.cfg.store.update((ledger) => {
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

    return { ok: true, event: ev };
  }

  private matchInvoice(ledger: Ledger, ev: RzpEvent): string | null {
    for (const inv of ledger.invoices()) {
      const ext = ledger.external(inv.id);
      if (!ext) continue;
      if (ev.paymentLinkId && ext.razorpayPaymentLinkId === ev.paymentLinkId) return inv.id;
      if (ev.invoiceId && ext.razorpayInvoiceId === ev.invoiceId) return inv.id;
      if (ev.virtualAccountId && ext.virtualAccountId === ev.virtualAccountId) return inv.id;
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

  async auditExport(format: "json" | "csv"): Promise<string> {
    const l = await this.cfg.store.load(this.cfg.policy);
    return format === "csv" ? l.audit.export("csv") : l.audit.export("json");
  }

  async auditEntries(): Promise<readonly AuditEntry[]> {
    return (await this.cfg.store.load(this.cfg.policy)).audit.all();
  }
}
