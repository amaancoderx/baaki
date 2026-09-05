import { gemini, formatINR } from "@baaki/core";
import { json, readState } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A Hinglish assistant grounded in the ledger.
 *
 * The interface is English because a dashboard should be scannable. Explaining
 * *why* the system did something is a different job, and a merchant would rather
 * ask that in the language they think in. So the screens stay English and the
 * conversation is Hinglish.
 *
 * Everything it says comes from state assembled here. It is given no tools and
 * cannot act, so asking it to chase someone gets an explanation of how to do
 * that on the Run page, not a message to a buyer.
 */
const SYSTEM = `You are Baaki AI. You explain a receivables system called Baaki to the
merchant who runs it.

HOW TO WRITE
Write the way an accountant in an Indian office actually speaks to their boss:
Hindi in Latin script, with the business words left in English. Say "invoice",
"payment", "link", "dispute", "promise", "reminder", "overdue", "guard",
"WhatsApp". Do not translate those into heavy Hindi. Never write in Devanagari.

Good: "Mehta ka payment abhi tak nahi aaya, unhone 15 tarikh ka promise kiya tha."
Bad: "Mehta ji ka bhugtaan abhi tak prapt nahi hua hai."

Keep it plain and short. Two or three sentences. Speak directly to the merchant
as "aap". Do not open with "Sir" or "Namaste". Do not use dashes to join
clauses; use a comma or start a new sentence. No markdown, no bullet points, no
headings. This is a chat bubble, not a document.

WHAT BAAKI DOES
It watches Razorpay invoices and keeps a ledger of who owes what. Once a day it
decides one action per open invoice, and most days that action is to wait. When
a buyer replies on WhatsApp, Baaki AI reads the reply: a promise freezes
outreach until that date, a dispute stops it and waits for the merchant. Before
anything goes out, a guard layer checks contact hours, message limits, minimum
gaps and do-not-contact.

RULES
Answer only from the ledger below. Never invent an invoice, a buyer, an amount
or a date. If the answer is not in the data, say so plainly and say which page
would have it. Use amounts exactly as they appear; never calculate a new figure.
You cannot send messages, create invoices or change anything, so if you are
asked to, say which page does it: Invoices, New invoice, Run agent, Audit.
Never mention which model or vendor you are. You are Baaki AI.`;

export async function POST(req: Request) {
  const { message, history } = (await req.json()) as {
    message: string;
    history?: { role: "user" | "model"; text: string }[];
  };
  if (!message?.trim()) return json({ error: "empty message" }, 400);
  if (!process.env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not set" }, 400);

  const state = await readState();
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

  const open = state.invoices.filter((i) => !["paid", "closed"].includes(i.invoice.substate));
  const collected = state.invoices.reduce((s, i) => s + i.invoice.amountPaid, 0);
  const billed = state.invoices.reduce((s, i) => s + i.invoice.amount, 0);
  const outstanding = open.reduce((s, i) => s + i.outstanding, 0);

  // A compact ledger snapshot. Recent history only: the whole audit log would
  // crowd out the question.
  const lines: string[] = [];
  lines.push(`Today: ${today}`);
  lines.push(`Billed ${formatINR(billed)}, recovered ${formatINR(collected)}, outstanding ${formatINR(outstanding)}.`);
  lines.push(`${state.invoices.length} invoices, ${open.length} open.`);
  lines.push("");

  for (const i of state.invoices.slice(0, 25)) {
    const inv = i.invoice;
    lines.push(
      `${inv.id} for ${i.buyer.name}: ${formatINR(i.outstanding)} outstanding of ${formatINR(inv.amount)}, ` +
      `due ${inv.dueOn}${i.daysOverdue > 0 ? ` (${i.daysOverdue} days overdue)` : ""}, status ${inv.substate}` +
      `${inv.promisedFor ? `, promised ${inv.promisedFor}` : ""}` +
      `${inv.disputeReason ? `, dispute: ${inv.disputeReason}` : ""}. ` +
      `${i.touches.length} messages sent, ${i.replies.length} replies.` +
      `${inv.linkExpiresOn && inv.linkExpiresOn < today ? " Payment link has expired." : ""}`,
    );
    for (const r of i.replies.slice(-2)) {
      lines.push(`   buyer said: "${r.text}", read as ${r.intent}${r.promiseDate ? ` for ${r.promiseDate}` : ""}`);
    }
    for (const a of i.audit.slice(-3)) {
      lines.push(`   [${a.actor}] ${a.action}: ${a.rationale}`);
    }
  }

  const p = state.policy;
  lines.push("");
  lines.push(`Rules in force: at most ${p.maxTouches} messages per invoice, at least ${p.minGapDays} days apart, ` +
    `contact only ${p.contactWindow.start}-${p.contactWindow.end} IST, campaign ends after ${p.campaignDays} days.`);

  const llm = gemini({
    apiKey: process.env.GEMINI_API_KEY,
    cacheDir: null,          // a conversation must not replay a cached answer
    minIntervalMs: 0,
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
  });

  const convo = (history ?? []).slice(-6)
    .map((h) => `${h.role === "user" ? "Merchant" : "You"}: ${h.text}`).join("\n");

  try {
    const answer = await llm.json<{ reply: string }>({
      system: SYSTEM,
      prompt: `Ledger right now:\n${lines.join("\n")}\n\n${convo ? `Conversation so far:\n${convo}\n\n` : ""}Merchant asks: ${message}`,
      schema: {
        type: "object",
        properties: { reply: { type: "string", description: "Your answer in Hinglish, two or three sentences." } },
        required: ["reply"],
      },
      temperature: 0.4,
      // A conversational answer needs no reasoning, and thinking draws from the
      // same budget as the reply. Left on, it truncates the answer mid-sentence.
      thinkingBudget: 0,
      maxOutputTokens: 700,
    });
    return json({ reply: answer.reply });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
