import { createHmac, timingSafeEqual } from "node:crypto";
import type { Paise } from "../money.js";

/**
 * Razorpay, test mode. Baaki sits on top of these primitives rather than
 * replacing them: the merchant keeps issuing Razorpay Invoices and Payment
 * Links, and Razorpay remains the source of truth for whether money arrived.
 */

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  baseUrl?: string;
}

export class RazorpayError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: unknown) {
    super(message);
    this.name = "RazorpayError";
  }
}

export interface RzpCustomer { id: string; name: string; email?: string; contact?: string }

export interface RzpInvoice {
  id: string;
  status: "draft" | "issued" | "partially_paid" | "paid" | "cancelled" | "expired" | "deleted";
  amount: Paise;
  amount_paid: Paise;
  amount_due: Paise;
  short_url: string;
  customer_id: string;
  expire_by?: number;
  receipt?: string;
  date?: number;
}

export interface RzpPaymentLink {
  id: string;
  status: "created" | "partially_paid" | "expired" | "cancelled" | "paid";
  amount: Paise;
  amount_paid: Paise;
  short_url: string;
  expire_by?: number;
  reference_id?: string;
}

export interface RzpVirtualAccount {
  id: string;
  status: "active" | "closed";
  amount_paid: Paise;
  customer_id: string;
  receivers: { id: string; entity: string; ifsc?: string; account_number?: string; username?: string; handle?: string; address?: string }[];
}

export function razorpay(cfg: RazorpayConfig) {
  const base = cfg.baseUrl ?? "https://api.razorpay.com/v1";
  const auth = "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");

  async function call<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const e = (json as { error?: { description?: string; code?: string } }).error;
      throw new RazorpayError(e?.description ?? `HTTP ${res.status}`, res.status, json);
    }
    return json as T;
  }

  return {
    /** Idempotent by contact: Razorpay rejects a duplicate, so reuse it. */
    async createCustomer(c: { name: string; contact?: string; email?: string; notes?: Record<string, string> }): Promise<RzpCustomer> {
      try {
        return await call<RzpCustomer>("POST", "/customers", { ...c, fail_existing: 0 });
      } catch (e) {
        if (e instanceof RazorpayError && e.status === 400) {
          const found = await call<{ items: RzpCustomer[] }>("GET", "/customers?count=100");
          const hit = found.items.find((x) => x.contact === c.contact);
          if (hit) return hit;
        }
        throw e;
      }
    },

    listCustomers: (count = 100) => call<{ items: RzpCustomer[] }>("GET", `/customers?count=${count}`),

    /**
     * An issued invoice with an expiry. `expire_by` is what makes a payment
     * path go stale, which is the condition reissue exists to repair.
     */
    async createInvoice(inv: {
      customerId: string;
      amount: Paise;
      description: string;
      receipt?: string;
      expireBy?: number;
      notes?: Record<string, string>;
    }): Promise<RzpInvoice> {
      return call<RzpInvoice>("POST", "/invoices", {
        type: "invoice",
        customer_id: inv.customerId,
        line_items: [{ name: inv.description, amount: inv.amount, currency: "INR", quantity: 1 }],
        currency: "INR",
        description: inv.description,
        ...(inv.receipt ? { receipt: inv.receipt } : {}),
        ...(inv.expireBy ? { expire_by: inv.expireBy } : {}),
        ...(inv.notes ? { notes: inv.notes } : {}),
        sms_notify: 0,
        email_notify: 0,
      });
    },

    getInvoice: (id: string) => call<RzpInvoice>("GET", `/invoices/${id}`),
    listInvoices: (count = 50) => call<{ items: RzpInvoice[] }>("GET", `/invoices?count=${count}`),
    cancelInvoice: (id: string) => call<RzpInvoice>("POST", `/invoices/${id}/cancel`),

    /** The fresh path handed to a buyer when the previous one expired. */
    createPaymentLink: (l: {
      amount: Paise;
      description: string;
      customer: { name: string; contact?: string; email?: string };
      expireBy?: number;
      referenceId?: string;
      notes?: Record<string, string>;
      /**
       * Razorpay delivers the link itself, once, when the link is created.
       * `reminder_enable` is never exposed: if Razorpay ran its own reminder
       * ladder, outreach would leave without passing the guard layer, the
       * touch budget would be quietly wrong, and every number in the evals
       * would describe a policy that is not the one running.
       */
      notify?: { sms?: boolean; email?: boolean };
    }) =>
      call<RzpPaymentLink>("POST", "/payment_links", {
        amount: l.amount,
        currency: "INR",
        description: l.description,
        customer: l.customer,
        notify: { sms: l.notify?.sms ?? false, email: l.notify?.email ?? false },
        reminder_enable: false,
        ...(l.expireBy ? { expire_by: l.expireBy } : {}),
        ...(l.referenceId ? { reference_id: l.referenceId } : {}),
        ...(l.notes ? { notes: l.notes } : {}),
      }),

    getPaymentLink: (id: string) => call<RzpPaymentLink>("GET", `/payment_links/${id}`),
    cancelPaymentLink: (id: string) => call<RzpPaymentLink>("POST", `/payment_links/${id}/cancel`),

    /**
     * Smart Collect: a per-buyer virtual account. A bank transfer into it is
     * attributable without the buyer quoting any reference, which is how
     * payments get matched to invoices without human cash application.
     */
    createVirtualAccount: (v: { customerId: string; description: string; notes?: Record<string, string> }) =>
      call<RzpVirtualAccount>("POST", "/virtual_accounts", {
        receivers: { types: ["bank_account", "vpa"] },
        description: v.description,
        customer_id: v.customerId,
        ...(v.notes ? { notes: v.notes } : {}),
      }),

    getVirtualAccount: (id: string) => call<RzpVirtualAccount>("GET", `/virtual_accounts/${id}`),
    closeVirtualAccount: (id: string) => call<RzpVirtualAccount>("POST", `/virtual_accounts/${id}/close`),

    getPayment: (id: string) => call<Record<string, unknown>>("GET", `/payments/${id}`),

    /**
     * HMAC-SHA256 over the raw body against the webhook secret. Verified on the
     * exact bytes received: re-serialising the JSON would reorder keys and
     * change the digest.
     */
    verifyWebhook(rawBody: string | Buffer, signature: string | undefined): boolean {
      if (!cfg.webhookSecret) return false;
      if (!signature) return false;
      const expected = createHmac("sha256", cfg.webhookSecret).update(rawBody).digest("hex");
      if (signature.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    },

    config: cfg,
  };
}

export type RazorpayClient = ReturnType<typeof razorpay>;

/** The webhook events Baaki acts on, per plan §4.1. */
export type RzpEventName =
  | "invoice.paid" | "invoice.expired" | "invoice.partially_paid"
  | "payment_link.paid" | "payment_link.expired"
  | "virtual_account.credited"
  | "payment.captured" | "payment.failed";

export interface RzpEvent {
  event: RzpEventName | string;
  /** Razorpay's own event id, used as the audit evidence link. */
  id: string;
  createdAt: number;
  /** Paise credited by this event, when the event carries a payment. */
  amount?: Paise;
  invoiceId?: string;
  paymentLinkId?: string;
  virtualAccountId?: string;
  paymentId?: string;
  referenceId?: string;
  notes?: Record<string, string>;
  raw: unknown;
}

export function parseRzpEvent(payload: unknown): RzpEvent {
  const p = payload as {
    event?: string; created_at?: number; id?: string;
    payload?: Record<string, { entity?: Record<string, any> }>;
  };
  const ent = p.payload ?? {};
  const invoice = ent.invoice?.entity;
  const link = ent.payment_link?.entity;
  const payment = ent.payment?.entity;
  const va = ent.virtual_account?.entity;

  return {
    event: p.event ?? "unknown",
    id: p.id ?? `evt_${p.created_at ?? Date.now()}`,
    createdAt: (p.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
    amount: payment?.amount ?? invoice?.amount_paid ?? link?.amount_paid,
    invoiceId: invoice?.id,
    paymentLinkId: link?.id,
    virtualAccountId: va?.id,
    paymentId: payment?.id,
    referenceId: link?.reference_id ?? invoice?.receipt,
    notes: payment?.notes ?? invoice?.notes ?? link?.notes,
    raw: payload,
  };
}
