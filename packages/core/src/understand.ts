import type { Llm } from "./llm/types.js";
import { addDays, type CivilDate } from "./time.js";
import type { ReplyIntent } from "./types.js";

export interface ParsedReply {
  intent: ReplyIntent;
  promiseDate?: CivilDate;
  disputeReason?: string;
  confidence: number;
}

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["will_pay", "promise", "dispute", "already_paid", "partial", "stop", "unclear"],
      description: "What the buyer is doing. 'promise' only when a specific date or day is given.",
    },
    promise_date: {
      type: "string",
      description: "ISO date YYYY-MM-DD, resolved against today. Omit unless intent is 'promise'.",
    },
    dispute_reason: {
      type: "string",
      description: "The buyer's stated reason, in their own words. Omit unless intent is 'dispute'.",
    },
    confidence: { type: "number", description: "0 to 1. Below 0.6 sends the case to a human." },
  },
  required: ["intent", "confidence"],
} as const;

const SYSTEM = `You read WhatsApp replies from Indian B2B buyers about overdue invoices.

The text is Hinglish, Hindi in Latin script, or English, often terse and misspelled.

Rules:
- "promise" requires a specific date or named day ("Friday", "15 tarikh", "next Monday", "month end"). A vague "will pay soon" or "dekhta hoon" is "will_pay", not a promise.
- Resolve relative dates against today's date, given below. "Friday" means the next Friday on or after tomorrow. "Month end" means the last day of the current month.
- "dispute" means they are contesting the amount, the goods, or the paperwork. Quote their reason in their own words.
- "already_paid" means they claim payment is done. "partial" means they say they paid some of it.
- "stop" means they are asking not to be contacted ("mat bhejo", "STOP", "don't message").
- "unclear" when you genuinely cannot tell. Prefer "unclear" with low confidence over guessing.
- Confidence is your honest read. A short ambiguous reply should score low.

Never infer an amount. Never invent a date the buyer did not give.`;

export interface UnderstandContext {
  today: CivilDate;
  buyerName: string;
  invoiceId: string;
  /** Prior touch the reply is answering, for context. */
  lastTouchBody?: string;
}

/**
 * Free text in, ledger transition out. Buttons never come through here: their
 * payload carries the meaning exactly, which is most of why the ladder uses
 * them. This is only for what buyers type themselves.
 */
export async function understandReply(
  llm: Llm,
  text: string,
  ctx: UnderstandContext,
): Promise<ParsedReply> {
  const prompt = [
    `Today is ${ctx.today} (${new Date(ctx.today + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}).`,
    `Buyer: ${ctx.buyerName}. Invoice: ${ctx.invoiceId}.`,
    ctx.lastTouchBody ? `They are replying to: "${ctx.lastTouchBody}"` : "",
    "",
    `Their reply: "${text}"`,
  ].filter(Boolean).join("\n");

  const raw = await llm.json<{
    intent: ReplyIntent;
    promise_date?: string;
    dispute_reason?: string;
    confidence: number;
  }>({
    system: SYSTEM,
    prompt,
    schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0,
    cacheKey: `understand:${ctx.today}:${text}`,
  });

  return normaliseParse(raw, ctx.today);
}

/**
 * Enforces the invariants the schema cannot. A model that returns intent
 * "promise" with no date, or a date in the past, has not given us a promise —
 * and acting on one would freeze outreach for nothing.
 */
export function normaliseParse(
  raw: { intent: ReplyIntent; promise_date?: string; dispute_reason?: string; confidence: number },
  today: CivilDate,
): ParsedReply {
  let intent = raw.intent;
  let promiseDate = raw.promise_date;
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));

  if (intent === "promise") {
    const valid = promiseDate && /^\d{4}-\d{2}-\d{2}$/.test(promiseDate) && !Number.isNaN(Date.parse(promiseDate));
    if (!valid) {
      intent = "will_pay";
      promiseDate = undefined;
    } else if (promiseDate! < today) {
      // A promise for a date already gone is not a promise.
      intent = "will_pay";
      promiseDate = undefined;
    } else if (promiseDate! > addDays(today, 120)) {
      // Beyond the campaign horizon; treat as vague rather than freeze for months.
      intent = "will_pay";
      promiseDate = undefined;
    }
  } else {
    promiseDate = undefined;
  }

  return {
    intent,
    ...(promiseDate ? { promiseDate } : {}),
    ...(intent === "dispute" && raw.dispute_reason ? { disputeReason: raw.dispute_reason } : {}),
    confidence,
  };
}
