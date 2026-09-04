import {
  Baaki, DEFAULT_POLICY, LedgerStore, gemini, razorpay, systemClock, whatsapp,
  type Policy,
} from "@baaki/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const POLICY_PATH = "data/policy.json";

/** Policy is editable from the dashboard, so it lives on disk, not in code. */
export function loadPolicy(): Policy {
  if (!existsSync(POLICY_PATH)) return DEFAULT_POLICY;
  return { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(POLICY_PATH, "utf8")) } as Policy;
}

export function savePolicy(p: Partial<Policy>): Policy {
  const next = { ...loadPolicy(), ...p };
  writeFileSync(POLICY_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function buildBaaki(): Baaki {
  const hasRzp = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const hasWa = Boolean(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID);

  return new Baaki({
    store: new LedgerStore("data/ledger.json"),
    policy: loadPolicy(),
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
        cacheDir: ".llm-cache",
        minIntervalMs: 2_000,
        model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
        fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
      }),
    } : {}),
    agent: { maxToolCalls: 4, timeoutMs: 20_000, onGuardReject: "retry-once-then-human" },
  });
}
