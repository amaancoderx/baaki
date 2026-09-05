import { addDays, type CivilDate } from "../time.js";
import { formatINR } from "../money.js";
import { razorpay } from "../razorpay/index.js";
import { whatsapp } from "../channels/whatsapp.js";
import type { LedgerStoreLike } from "../store.js";
import { DEFAULT_POLICY, type Policy } from "../types.js";
import type { Ledger } from "../ledger.js";

/**
 * In-call tools. A voice call is the least reviewable channel there is, since
 * no one reads it before it happens, so the tools are deliberately narrow:
 * record what the buyer said, or hand the call to a person. Nothing here
 * argues, negotiates, or agrees to a discount.
 */

export const VOICE_TOOLS = [
  {
    name: "record_promise",
    description: "The buyer committed to paying by a specific date. Only call this when they named a date.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO date YYYY-MM-DD, resolved against today." },
        note: { type: "string", description: "The buyer's exact words as heard, verbatim, in their language. Not a summary." },
      },
      required: ["date"],
    },
  },
  {
    name: "record_dispute",
    description: "The buyer is contesting the invoice. Record it and stop chasing. Do not argue the point.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Their stated reason, in their words." } },
      required: ["reason"],
    },
  },
  {
    name: "send_payment_link_now",
    description: "Send a fresh payment link to this buyer on WhatsApp while they are on the call.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "set_do_not_call",
    description: "The buyer asked not to be contacted again. Permanent, and applies to every channel.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
    },
  },
  {
    name: "escalate_to_human",
    description: "Hand the call to a person. Use whenever the buyer asks for one, is angry, disputes something complicated, or you are unsure.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
] as const;

export interface VoiceContext {
  invoiceId: string;
  buyerName: string;
  buyerPhone: string;
  outstanding: number;
  dueOn: CivilDate;
  daysOverdue: number;
  today: CivilDate;
  shortUrl?: string;
}

export interface ToolOutcome { ok: boolean; detail: string; endCall?: boolean }

/**
 * When the voice bridge runs away from the ledger (on Vercel next to Twilio,
 * while the ledger stays on the merchant's machine) tool effects travel over
 * HTTP instead of touching the store directly. Only tool calls take this hop,
 * a handful per call; the audio path never leaves the region it started in.
 */
export async function runVoiceToolRemote(
  apiBase: string,
  name: string,
  args: Record<string, unknown>,
  ctx: VoiceContext,
  callSid: string,
): Promise<ToolOutcome> {
  try {
    const res = await fetch(`${apiBase}/api/voice/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId: ctx.invoiceId, name, args, callSid }),
    });
    if (!res.ok) return { ok: false, detail: `ledger returned ${res.status}` };
    return (await res.json()) as ToolOutcome;
  } catch (e) {
    // A failed write must not be reported to the buyer as recorded.
    return { ok: false, detail: `could not reach the ledger: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function runVoiceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: VoiceContext,
  store: LedgerStoreLike,
  policy: Policy = DEFAULT_POLICY,
  callSid = "browser",
  nowMs?: number,
): Promise<ToolOutcome> {
  // The ledger's clock. On a moved calendar these entries were stamped with
  // the wall clock, so everything agreed on a Day-12 call rendered under Day 0.
  const now = nowMs ?? Date.now();
  const evidence = [`call:${callSid}`];

  switch (name) {
    case "record_promise": {
      const date = String(args.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < ctx.today) {
        return { ok: false, detail: "That date is not usable. Ask them for a specific day." };
      }
      await store.update((l: Ledger) => {
        l.recordReply({
          invoiceId: ctx.invoiceId, buyerId: l.invoice(ctx.invoiceId).buyerId, ts: now,
          channel: "whatsapp", source: "free_text",
          text: `[voice call] ${String(args.note ?? `promised payment by ${date}`)}`,
          intent: "promise", promiseDate: date, confidence: 0.9,
        });
      }, policy);
      return { ok: true, detail: `Recorded. Outreach is frozen until ${date}.`, endCall: true };
    }

    case "record_dispute": {
      const reason = String(args.reason ?? "buyer contested the invoice on a call");
      await store.update((l: Ledger) => {
        l.recordReply({
          invoiceId: ctx.invoiceId, buyerId: l.invoice(ctx.invoiceId).buyerId, ts: now,
          channel: "whatsapp", source: "free_text",
          text: `[voice call] ${reason}`, intent: "dispute", disputeReason: reason, confidence: 0.9,
        });
      }, policy);
      return { ok: true, detail: "Recorded. Outreach is frozen and the merchant has been notified.", endCall: true };
    }

    case "send_payment_link_now": {
      // The buyer is on the phone saying they will pay right now. Two things
      // have to be true a minute from now: the link in their WhatsApp is live,
      // and it is actually in their WhatsApp. This tool used to guarantee
      // neither: it minted a payment link (capped far below invoices, so a
      // busy account threw 429 and the whole tool 500ed mid-call) and then
      // told the model the URL without sending the buyer anything, so "link
      // sent" was true only inside the conversation.
      if (!process.env.RAZORPAY_KEY_ID) return { ok: false, detail: "Payments are not configured." };
      const rzp = razorpay({
        keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET!,
      });

      const l0 = await store.load(policy);
      const existing = l0.external?.(ctx.invoiceId);
      let shortUrl = ctx.shortUrl ?? existing?.shortUrl ?? "";
      let freshId: string | null = null;

      const linkLive = l0.linkIsLive?.(l0.invoice(ctx.invoiceId), ctx.today) ?? false;
      if (!linkLive || !shortUrl) {
        const customerId = existing?.razorpayCustomerId
          ?? (await rzp.createCustomer({ name: ctx.buyerName, contact: `+${ctx.buyerPhone}` })).id;
        const fresh = await rzp.createInvoice({
          customerId,
          amount: ctx.outstanding,
          description: `Invoice ${ctx.invoiceId} (sent during a call)`,
          receipt: `baaki_call_${ctx.invoiceId}_${now}`,
          notes: { baaki_invoice_id: ctx.invoiceId },
          expireBy: Math.floor(Math.max(
            Date.parse(`${addDays(ctx.today, 14)}T18:00:00+05:30`),
            Date.now() + 30 * 60_000,
          ) / 1000),
        });
        shortUrl = fresh.short_url;
        freshId = fresh.id;
      }

      // The buyer just spoke to us on a call, but a call does not open a
      // WhatsApp session window, so free-form only goes when an inbound
      // message already opened one.
      let delivered = false;
      let deliveryNote = "WhatsApp is not configured, so the link was only read out.";
      if (process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN) {
        const wa = whatsapp({
          phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
          accessToken: process.env.WA_ACCESS_TOKEN,
          appSecret: process.env.WA_APP_SECRET,
          dryRun: process.env.WA_DRY_RUN === "1",
        });
        const lastReply = l0.repliesFor?.(ctx.invoiceId)?.at(-1);
        const inSession = lastReply ? now - lastReply.ts <= 24 * 3600_000 : false;
        try {
          const res = inSession
            ? await wa.sendText(ctx.buyerPhone, `Namaste ${ctx.buyerName}, jaisa abhi call par baat hui, ${formatINR(ctx.outstanding)} ka payment link:\n\n${shortUrl}`)
            : await wa.sendTemplate({ to: ctx.buyerPhone, template: "hello_world", language: "en_US", bodyParams: [] });
          delivered = true;
          deliveryNote = `sent on WhatsApp (${res.messageId})`;
        } catch (e) {
          deliveryNote = `WhatsApp send failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      await store.update((l: Ledger) => {
        if (freshId) {
          l.noteExternal(ctx.invoiceId, { razorpayInvoiceId: freshId, shortUrl });
          l.invoice(ctx.invoiceId).linkExpiresOn = addDays(ctx.today, 14);
        }
        l.audit.append({
          ts: now, invoiceId: ctx.invoiceId, actor: "agent", action: "reissue_payment_path",
          params: { shortUrl, via: "voice call", delivered, ...(freshId ? { razorpayInvoiceId: freshId } : {}) },
          rationale: `Buyer asked to pay during the call. ${freshId ? "Fresh link issued and " : "Live link "}${deliveryNote}.`,
          guards: [], policyVersion: policy.policyVersion, evidence: [freshId ?? shortUrl, ...evidence].filter(Boolean),
        });
      }, policy);
      return { ok: true, detail: delivered ? `Link is in their WhatsApp: ${shortUrl}` : `Link ready (${shortUrl}) but ${deliveryNote}` };
    }

    case "set_do_not_call": {
      await store.update((l: Ledger) => {
        l.recordReply({
          invoiceId: ctx.invoiceId, buyerId: l.invoice(ctx.invoiceId).buyerId, ts: now,
          channel: "whatsapp", source: "free_text",
          text: `[voice call] ${String(args.reason ?? "asked not to be contacted")}`,
          intent: "stop", confidence: 1,
        });
      }, policy);
      return { ok: true, detail: "Recorded. This buyer will not be contacted again on any channel.", endCall: true };
    }

    case "escalate_to_human": {
      const reason = String(args.reason ?? "buyer asked for a person");
      await store.update((l: Ledger) => {
        l.setSubstate(ctx.invoiceId, "human_hold",
          `Voice call handed to a person: ${reason}`, "agent", evidence);
      }, policy);
      return { ok: true, detail: "A person will call back.", endCall: true };
    }

    default:
      return { ok: false, detail: `unknown tool ${name}` };
  }
}

/** Consent first, always, and in the buyer's language. */
export function systemInstruction(ctx: VoiceContext): string {
  return `You are a woman from the merchant's accounts team, calling about one unpaid invoice. Use feminine verb forms in Hindi throughout: "kar rahi hoon", "bol rahi hoon", never "raha".

You are calling on behalf of a merchant about one unpaid invoice. You are not a debt collector and you do not negotiate.

Open with exactly this, in the buyer's language, before anything else:
"Namaste, main ${ctx.buyerName} ke liye ek payment reminder ke silsile mein call kar rahi hoon. Ye call record ho rahi hai. Do minute baat kar sakte hain?"

If they say no, thank them and end the call. Do not push.

The invoice:
- Amount outstanding: ${formatINR(ctx.outstanding)}, say it in Hindi words ("ek lakh assi hazaar rupaye"), never as digits
- Was due: ${ctx.dueOn} (${ctx.daysOverdue} days ago)
- Today is ${ctx.today}

What you are for:
- Ask when they can pay. If they name a date, call record_promise with that date resolved to YYYY-MM-DD. Resolve relative phrases against today: "parso" is two days from today, "agle hafte Tuesday" is the Tuesday of next week, not this week's.
- If they dispute the invoice, call record_dispute and stop. Do not defend the invoice, do not explain why they are wrong, do not ask them to reconsider.
- If they want the payment link, call send_payment_link_now.
- If they ask not to be called again, call set_do_not_call.
- If they are angry, want a person, or the situation is anything other than the four above, call escalate_to_human.

How to speak:
- Speak Hindi by default, in the Devanagari-spoken register an Indian buyer uses on the phone. Switch to English only if they clearly speak English to you. Never start in English.
- Short sentences. This is a phone call, not a letter. One sentence is usually enough.
- Never repeat a sentence you have already said. If she did not hear you, say it differently and shorter.
- Confirm in one line and stop. "Theek hai, maine note kar liya", not a paragraph explaining what you recorded.
- Speak every number as Hindi words. "22 din", not "twenty-two days". Digits read aloud in English are the fastest way to sound like a robot.
- Warm and unhurried. You are a person from the accounts team, not a recorded announcement.
- Never state an amount other than ${formatINR(ctx.outstanding)}. Never offer a discount, a waiver, or an instalment plan. Never mention legal action, courts, or consequences.
- Never claim payment has been received. Only the payment provider knows that.

End the call once you have recorded something or been told no. Do not keep talking.`;
}
