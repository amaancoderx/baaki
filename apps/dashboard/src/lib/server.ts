import {
  Baaki, LIVE_POLICY, RedisLedgerStore, gemini, razorpay, syntheticContacts,
  systemClock, whatsapp, type Clock, type Contact, type Policy, type VoiceCaller,
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

/**
 * How far ahead of real time the app is running.
 *
 * The whole arc of an invoice takes weeks and a demo has minutes, so the clock
 * can be moved forward. Nothing else changes: a jump runs a real tick that
 * really sends, and the guards see the moved time rather than being bypassed.
 * Persisted in Redis so every function instance agrees on what day it is.
 */
export const DEMO_OFFSET_KEY = "baaki:demo:offsetMs";

export async function demoOffset(): Promise<number> {
  const v = await redis().get<number | string>(DEMO_OFFSET_KEY);
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n !== null ? Number(n) : 0;
}

export async function setDemoOffset(ms: number): Promise<void> {
  await redis().set(DEMO_OFFSET_KEY, Math.max(0, Math.round(ms)));
}

/** Real time plus the demo offset. Never runs backwards. */
export const offsetClock = (offsetMs: number): Clock => ({ now: () => Date.now() + offsetMs });

export async function clock(): Promise<Clock> {
  const off = await demoOffset();
  return off === 0 ? systemClock() : offsetClock(off);
}

export const store = () => new RedisLedgerStore(redis(), systemClock());

export async function policy(): Promise<Policy> {
  const stored = await store().loadPolicy();
  // The store's baseline is DEFAULT_POLICY, whose voice is off so that the
  // simulator, and therefore every published collection figure, describes the
  // message-only policy. The deployed product is the thing that picks up the
  // phone, so voice is turned on here rather than in the measured default.
  return {
    ...stored,
    voice: { ...(stored.voice ?? LIVE_POLICY.voice!), enabled: true },
    // The stored version is kept. Stamping LIVE_POLICY's over it made the
    // compressed demo cadence indistinguishable from the shipped one, which is
    // the one thing the screen has to be able to tell the viewer.
    policyVersion: stored.policyVersion ?? LIVE_POLICY.policyVersion,
  };
}

/**
 * Places the call through this deployment's own Twilio credentials and points
 * Twilio back at this origin for the TwiML. Injected into Baaki so core never
 * has to know a telephony vendor.
 */
export function twilioCaller(origin: string): VoiceCaller | undefined {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return undefined;

  return {
    async placeCall({ to, invoiceId }) {
      const body = new URLSearchParams({
        To: to.startsWith("+") ? to : `+${to}`,
        From: from,
        Url: `${origin}/api/voice/answer?invoice=${encodeURIComponent(invoiceId)}`,
        Record: "true",
        Timeout: "30",
      });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const out = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(out.message ?? `twilio ${res.status}`));
      return { sid: String(out.sid), status: String(out.status) };
    },
  };
}

export async function contacts(): Promise<Contact[]> {
  return store().loadContacts<Contact>(() => syntheticContacts());
}

export async function baaki(opts: { origin?: string } = {}): Promise<Baaki> {
  const p = await policy();
  const clk = await clock();
  const caller = opts.origin ? twilioCaller(opts.origin) : undefined;
  const hasRzp = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const hasWa = Boolean(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID);

  return new Baaki({
    store: store(),
    policy: p,
    clock: clk,
    ...(caller ? { voice: caller } : {}),
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
    ...(process.env.WA_WABA_ID ? { wabaId: process.env.WA_WABA_ID } : {}),
    // Serialises work on the same invoice across function instances and drops
    // redelivered webhooks.
    redis: redis() as never,
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
  const off = await demoOffset();
  const now = Date.now() + off;
  return {
    policy: p,
    demoOffsetMs: off,
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
