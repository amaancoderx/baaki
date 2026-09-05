import {
  Baaki, DEFAULT_POLICY, RedisLedgerStore, gemini, razorpay, syntheticContacts,
  systemClock, whatsapp, type Contact, type Policy,
} from "@baaki/core";
import { Redis } from "@upstash/redis";

/**
 * Server wiring for the deployed app. Everything durable lives in Redis: a
 * serverless function gets an ephemeral disk and no shared state between
 * instances, so the file-backed store that works on a laptop loses every write
 * in production.
 */

let _redis: Redis | null = null;
export function redis(): Redis {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
}

export const store = () => new RedisLedgerStore(redis(), systemClock());

export async function policy(): Promise<Policy> {
  return store().loadPolicy();
}

export async function contacts(): Promise<Contact[]> {
  return store().loadContacts<Contact>(() => syntheticContacts());
}

export async function baaki(): Promise<Baaki> {
  const p = await policy();
  const hasRzp = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const hasWa = Boolean(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID);

  return new Baaki({
    store: store(),
    policy: p,
    clock: systemClock(),
    ...(hasRzp ? {
      razorpay: razorpay({
        keyId: process.env.RAZORPAY_KEY_ID!,
        keySecret: process.env.RAZORPAY_KEY_SECRET!,
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
      }),
    } : {}),
    ...(hasWa ? {
      whatsapp: whatsapp({
        phoneNumberId: process.env.WA_PHONE_NUMBER_ID!,
        accessToken: process.env.WA_ACCESS_TOKEN!,
        appSecret: process.env.WA_APP_SECRET,
        verifyToken: process.env.WA_VERIFY_TOKEN,
        dryRun: process.env.WA_DRY_RUN === "1",
      }),
    } : {}),
    ...(process.env.GEMINI_API_KEY ? {
      llm: gemini({
        apiKey: process.env.GEMINI_API_KEY,
        // No disk cache in a serverless function.
        cacheDir: null,
        minIntervalMs: 0,
        model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
        fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
      }),
    } : {}),
    agent: { maxToolCalls: 4, timeoutMs: 20_000, onGuardReject: "retry-once-then-human" },
  });
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Server-side read for the pages. A server component fetching its own API
 * route would pay a network hop to reach code already in the same process.
 */
export async function readState(): Promise<import("./api").AppState> {
  const p = await policy();
  const ledger = await store().load(p);
  const now = Date.now();
  return {
    policy: p,
    contacts: await contacts(),
    invoices: ledger.invoices().map((inv) => {
      const c = ledger.caseFile(inv.id, now);
      return {
        invoice: inv, buyer: c.buyer, memory: c.memory,
        daysOverdue: c.daysOverdue,
        outstanding: inv.amount - inv.amountPaid,
        external: ledger.external(inv.id) ?? {},
        touches: c.touches, replies: c.replies, payments: c.payments,
        audit: ledger.audit.forInvoice(inv.id),
      };
    }),
  } as import("./api").AppState;
}
