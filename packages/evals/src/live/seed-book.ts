/**
 * Replaces the ledger with a small book of invoices that have real histories.
 *
 * WHAT IS FABRICATED, AND NOTHING ELSE IS
 * --------------------------------------
 * Two things are authored here:
 *
 *   1. The buyer's words, in `SCRIPT` below. A real buyer did not type them.
 *   2. The calendar. The clock is moved forward so a six-week history exists
 *      without waiting six weeks.
 *
 * Everything else is the running system. Each invoice is a real Razorpay
 * invoice with a real payment page. Each reply is delivered as a Meta-shaped
 * webhook, signed with the app secret, through `handleWhatsappWebhook`: the
 * signature is verified, the payload parsed, and the intent and promise date
 * are read by the model, not written here. Every decision comes from the same
 * router, the same policy and the same guards that run in production, and
 * every audit entry is written by the code that writes them normally.
 *
 * So the trails are real traces of fabricated conversations. That distinction
 * is the reason this file exists rather than a fixture of hand-written audit
 * rows, which would have been quicker and worth nothing.
 *
 * The WhatsApp transport is stubbed (WA_DRY_RUN=1) so seeding does not message
 * strangers. Sends are decided, guarded and logged exactly as normal; only the
 * HTTP call to Meta is skipped.
 *
 *   WA_DRY_RUN=1 tsx packages/evals/src/live/seed-book.ts
 */
import { createHmac } from "node:crypto";
import {
  Baaki, LIVE_POLICY, Ledger, RedisLedgerStore, gemini, razorpay, whatsapp,
  type Clock, type Contact,
} from "@baaki/core";
import { Redis } from "@upstash/redis";

const DAY = 86_400_000;

/** Razorpay test mode refuses a single invoice above this. */
const MAX_TEST_RUPEES = 500_000;

/** The authored part. Real Hinglish, the way buyers actually write. */
const SCRIPT: {
  name: string; city: string; phone: string; email: string;
  amountRupees: number; termDays: number; issuedDaysAgo: number;
  /** Days from now (negative = in the past) when the buyer wrote, and what they wrote. */
  replies: { onDay: number; text: string }[];
  /** Days ago the money landed, when it did. Delivered as a signed Razorpay webhook. */
  paidOnDay?: number;
  want: string;
}[] = [
  {
    name: "Krishna Enterprises", city: "Surat", phone: "919000000102",
    email: "accounts@krishnaenterprises.example",
    amountRupees: 245000, termDays: 30, issuedDaysAgo: 34,
    replies: [{ onDay: -6, text: "bhai is hafte to nahi ho payega, agle mangalwar tak kar dunga pakka" }],
    want: "a promise in flight: outreach frozen until the date the buyer gave",
  },
  {
    name: "Patel Textiles", city: "Ahmedabad", phone: "919000000103",
    email: "accounts@pateltextiles.example",
    amountRupees: 118000, termDays: 45, issuedDaysAgo: 52,
    replies: [{ onDay: -9, text: "maal me 3 thaan kam aaye the, uska credit note pending hai. pehle wo settle karo" }],
    want: "a dispute: outreach stopped, waiting on a person",
  },
  {
    name: "Gupta Steel", city: "Raipur", phone: "919000000108",
    email: "accounts@guptasteel.example",
    amountRupees: 412000, termDays: 30, issuedDaysAgo: 49,
    replies: [],
    want: "silent through the ladder, then called: the case the phone exists for",
  },
  {
    name: "Bhatia Electricals", city: "Delhi", phone: "919000000111",
    email: "accounts@bhatiaelectricals.example",
    amountRupees: 32000, termDays: 21, issuedDaysAgo: 4,
    replies: [],
    want: "young and quiet: nothing due yet, nothing to do",
  },
  {
    name: "Mehta & Sons", city: "Mumbai", phone: "919000000104",
    email: "accounts@mehtasons.example",
    amountRupees: 418000, termDays: 30, issuedDaysAgo: 47,
    replies: [{ onDay: -21, text: "link expire ho gaya tha, naya bhejo to kar deta hu" }],
    paidOnDay: 19,
    want: "recovered after the dead link was repaired: the thing the ablation says pays",
  },
  {
    name: "Verma Industries", city: "Kanpur", phone: "919000000106",
    email: "accounts@vermaindustries.example",
    amountRupees: 267000, termDays: 45, issuedDaysAgo: 58,
    replies: [{ onDay: -30, text: "sorry bhai thoda late ho gaya, is week clear kar dunga" }],
    paidOnDay: 26,
    want: "promised late, then paid: outreach stayed frozen and it still landed",
  },
  {
    name: "Lakshmi Agencies", city: "Coimbatore", phone: "919000000107",
    email: "accounts@lakshmiagencies.example",
    amountRupees: 154000, termDays: 30, issuedDaysAgo: 39,
    replies: [],
    paidOnDay: 31,
    want: "paid off the first reminder, before the ladder went anywhere",
  },
];

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

/** A Meta webhook, shaped and signed the way Meta shapes and signs one. */
function waWebhook(phone: string, text: string, at: number, secret: string): { body: string; sig: string } {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "seed",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "0", phone_number_id: "seed" },
          contacts: [{ profile: { name: "buyer" }, wa_id: phone }],
          messages: [{
            from: phone,
            id: `wamid.seed_${Math.abs(hash(text))}`,
            timestamp: String(Math.floor(at / 1000)),
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  });
  return { body, sig: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
}

/**
 * A Razorpay `invoice.paid` webhook, signed with the account's webhook secret.
 *
 * Only the payment provider is allowed to say money moved, and this seed does
 * not get to bypass that. The event goes in through the same handler a real one
 * does: the signature is verified, the event is matched to an invoice by its
 * Razorpay id, and the case closes because the ledger decided it should.
 */
function rzpWebhook(
  rzpInvoiceId: string, amountPaise: number, at: number, secret: string,
): { body: string; sig: string } {
  const body = JSON.stringify({
    entity: "event",
    event: "invoice.paid",
    created_at: Math.floor(at / 1000),
    payload: {
      invoice: { entity: { id: rzpInvoiceId, amount_paid: amountPaise, status: "paid" } },
      payment: { entity: { id: `pay_seed_${Math.abs(hash(rzpInvoiceId))}`, amount: amountPaise } },
    },
  });
  return { body, sig: createHmac("sha256", secret).update(body).digest("hex") };
}

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

async function main(): Promise<void> {
  const redis = Redis.fromEnv();
  const appSecret = need("WA_APP_SECRET");

  // The clock the whole seed runs on, moved forward day by day.
  let now = Date.now() - 60 * DAY;
  const clock: Clock = { now: () => now };

  const store = new RedisLedgerStore(redis, clock);

  const build = (): Baaki => new Baaki({
    store, policy: LIVE_POLICY, clock,
    razorpay: razorpay({
      keyId: need("RAZORPAY_KEY_ID"),
      keySecret: need("RAZORPAY_KEY_SECRET"),
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    }),
    whatsapp: whatsapp({
      phoneNumberId: need("WA_PHONE_NUMBER_ID"),
      accessToken: need("WA_ACCESS_TOKEN"),
      appSecret,
      verifyToken: process.env.WA_VERIFY_TOKEN,
      dryRun: process.env.WA_DRY_RUN === "1",
    }),
    ...(process.env.GEMINI_API_KEY ? {
      llm: gemini({
        apiKey: process.env.GEMINI_API_KEY,
        cacheDir: null, minIntervalMs: 0,
        model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
      }),
    } : {}),
    ...(process.env.WA_WABA_ID ? { wabaId: process.env.WA_WABA_ID } : {}),
    // The decision to call, the guards it passes and the audit entry are all
    // real. Only the dialling is skipped: these are authored buyers and nobody
    // is holding these numbers.
    voice: {
      placeCall: async ({ invoiceId }) => ({ sid: `CA_seed_${invoiceId}`, status: "completed", dryRun: true }),
    },
    agent: { maxToolCalls: 4, timeoutMs: 20_000, onGuardReject: "retry-once-then-human" },
  });

  console.error("clearing the ledger");
  await store.save(new Ledger({ policy: LIVE_POLICY, clock }));
  await store.saveContacts(SCRIPT.map((r, n): Contact => ({
    id: `c_seed_${n + 1}`, name: r.name, phone: r.phone, email: r.email,
    city: r.city, termDays: r.termDays, language: "hinglish",
    // Not sendable: these are authored buyers and nobody is holding these
    // numbers. The demo screen is where a real number goes.
    sendable: false,
    notes: "Seeded book. The buyer's words are authored; the history is not.",
  })));

  const contacts = await store.loadContacts<Contact>(() => []);

  // Raise each invoice on the day it was actually issued, so the ledger dates
  // and the Razorpay dates agree.
  const ids: string[] = [];
  const payPath = new Map<string, string>();
  for (let n = 0; n < SCRIPT.length; n++) {
    const row = SCRIPT[n]!;
    now = Date.now() - row.issuedDaysAgo * DAY;
    if (row.amountRupees > MAX_TEST_RUPEES) {
      throw new Error(`${row.name}: ₹${row.amountRupees} exceeds the test-mode cap of ₹${MAX_TEST_RUPEES}`);
    }
    const out = await build().createInvoice({
      contact: contacts[n]!,
      amount: row.amountRupees * 100,
      description: `Supply against PO ${4400 + n * 7}`,
      termDays: row.termDays,
      // Short on purpose for two of them: a link that dies before it is needed
      // is the condition reissue exists to repair, and it is 40% of invoices.
      linkValidDays: n % 2 === 0 ? Math.max(7, row.termDays - 10) : row.termDays + 7,
    });
    ids.push(out.invoice.id);
    payPath.set(out.invoice.id, out.razorpay?.invoiceId ?? out.razorpay?.paymentLinkId ?? out.invoice.id);
    console.error(`  ${out.invoice.id}  ${row.name}  (${row.want})`);
    // Onboarding a book is a burst, and the test account rate-limits one.
    // The adapter retries; pacing here keeps it from having to.
    await new Promise((r) => setTimeout(r, 12_000));
  }

  // Walk the calendar forward one day at a time, ticking for real and posting
  // the authored replies on the day the script says they arrived.
  const earliest = Math.max(...SCRIPT.map((r) => r.issuedDaysAgo));
  for (let d = earliest; d >= 0; d--) {
    now = Date.now() - d * DAY;
    // Mid-morning, so the contact window is open and the guards are being
    // satisfied rather than dodged.
    const ist = new Date(now);
    ist.setUTCHours(5, 30, 0, 0);
    now = ist.getTime();

    for (const row of SCRIPT) {
      for (const rep of row.replies) {
        if (-rep.onDay !== d) continue;
        const { body, sig } = waWebhook(row.phone, rep.text, now, appSecret);
        const res = await build().handleWhatsappWebhook(body, sig);
        console.error(`  day -${d}  ${row.name} wrote: "${rep.text.slice(0, 46)}" -> handled ${res.handled}`);
      }
    }

    const rzpSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    for (let n = 0; n < SCRIPT.length; n++) {
      const row = SCRIPT[n]!;
      if (row.paidOnDay !== d || !rzpSecret) continue;
      const id = ids[n]!;
      const { body, sig } = rzpWebhook(payPath.get(id) ?? id, row.amountRupees * 100, now, rzpSecret);
      const res = await build().handleRazorpayWebhook(body, sig);
      console.error(`  day -${d}  ${row.name} paid ₹${row.amountRupees.toLocaleString("en-IN")} -> ${res.ok ? "recorded" : res.reason}`);
    }

    const report = await build().tick();
    const did = report.actions.filter((a) => a.action.kind !== "none");
    for (const a of did) {
      console.error(`  day -${d}  ${a.invoiceId} ${a.action.kind}${a.sent ? " (sent)" : ""}`);
    }
  }

  const final = await store.load(LIVE_POLICY);
  console.error("\nfinal states:");
  for (const inv of final.invoices()) {
    console.error(`  ${inv.id}  ${final.buyer(inv.buyerId).name.padEnd(26)} ${inv.substate.padEnd(14)} ${final.audit.forInvoice(inv.id).length} audit entries`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
