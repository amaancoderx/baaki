import {
  DEFAULT_POLICY, LedgerStore, formatINR, gemini, type Llm, type Policy, type ToolCall,
} from "@baaki/core";
import { runVoiceTool, VOICE_TOOLS, type VoiceContext } from "./tools.js";

/**
 * Turn-based phone calls over plain HTTPS webhooks.
 *
 * The Media Streams path in live.ts is better — real duplex audio with
 * barge-in — but it needs a WebSocket endpoint Twilio can reach, and free
 * tunnels either reject Twilio's upgrade (Cloudflare quick tunnels, 31951) or
 * fall over mid-demo (localtunnel). This path needs nothing but ordinary HTTPS
 * POSTs, so it runs anywhere the webhook service already runs.
 *
 * Twilio does the speech recognition, Gemini does the understanding and the
 * tool calls, Twilio speaks the reply. Same tools, same ledger, same audit.
 */

/**
 * Hindi numerals, spelled out. "1 lakh 80 hazaar rupees" is not a sentence
 * anyone says: the digits get read in English, the units in Hindi, and the
 * result sounds like a machine reading a spreadsheet. A buyer hears
 * "ek lakh assi hazaar rupaye".
 */
const HI_ONES = [
  "shunya", "ek", "do", "teen", "chaar", "paanch", "chhe", "saat", "aath", "nau",
  "das", "gyarah", "barah", "terah", "chaudah", "pandrah", "solah", "satrah", "atharah", "unnees",
  "bees", "ikkees", "baees", "teiys", "chaubees", "pachchees", "chhabbees", "sattaees", "atthaees", "untees",
  "tees", "iktees", "battees", "taintees", "chauntees", "paintees", "chhattees", "saintees", "adtees", "untaalees",
  "chaalees", "iktaalees", "bayaalees", "taintaalees", "chavaalees", "paintaalees", "chhiyaalees", "saintaalees", "adtaalees", "unchaas",
  "pachaas", "ikyaavan", "baavan", "tirpan", "chauvan", "pachpan", "chhappan", "sattaavan", "atthaavan", "unsath",
  "saath", "iksath", "baasath", "tirsath", "chausath", "paisath", "chhiyaasath", "sadsath", "adsath", "unhattar",
  "sattar", "ikhattar", "bahattar", "tihattar", "chauhattar", "pachhattar", "chhihattar", "sathattar", "athhattar", "unaasi",
  "assi", "ikyaasi", "bayaasi", "tirasi", "chauraasi", "pachaasi", "chhiyaasi", "sattaasi", "atthaasi", "nawaasi",
  "nabbe", "ikyaanve", "baanve", "tiraanve", "chauraanve", "pachaanve", "chhiyaanve", "sattaanve", "atthaanve", "ninyaanve",
];

function hindiNumber(n: number): string {
  if (n < 100) return HI_ONES[n] ?? String(n);
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    return `${HI_ONES[h]} sau${r ? " " + hindiNumber(r) : ""}`;
  }
  return String(n);
}

/** Spoken amount in Hindi: "ek lakh assi hazaar rupaye". */
export function spokenAmount(paise: number): string {
  const r = Math.round(paise / 100);
  const lakh = Math.floor(r / 100000);
  const rest = r % 100000;
  const thousand = Math.floor(rest / 1000);
  const units = rest % 1000;

  const parts: string[] = [];
  if (lakh) parts.push(`${hindiNumber(lakh)} lakh`);
  if (thousand) parts.push(`${hindiNumber(thousand)} hazaar`);
  if (units) parts.push(hindiNumber(units));
  return parts.length ? `${parts.join(" ")} rupaye` : "shunya rupaye";
}

/** Days in Hindi, so "22 din" is not read as "twenty-two din". */
export const spokenDays = (n: number): string => `${hindiNumber(n)} din`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Kajal is Polly's neural bilingual Hindi/Indian-English voice, which is what
 * makes a Hinglish sentence sound like one sentence. Aditi, the standard
 * Indian English voice, read Hindi words phonetically as English and sounded
 * like a machine. Override with VOICE_TTS if a different voice is preferred.
 */
const TTS_VOICE = process.env.VOICE_TTS ?? "Polly.Kajal-Neural";
const VOICE_ATTR = `voice="${TTS_VOICE}" language="hi-IN"`;

/**
 * Words the recogniser should expect. Twilio's default English model turned
 * "Friday tak kar dunga" into "Main abhi aapko to kar lunga" at confidence 0.0;
 * biasing toward the vocabulary an overdue-invoice call actually contains is
 * most of the fix, along with a model built for conversational speech.
 */
const SPEECH_HINTS = [
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  "somvar","mangalvar","budhvar","guruvar","shukravar","shanivar","ravivar",
  "aaj","kal","parso","agle hafte","is hafte","month end","mahine ke end",
  "tarikh","tareekh","pehli","do din","teen din","ek hafta",
  "paisa","payment","bhej dunga","kar dunga","ho jayega","clear kar denge",
  "transfer","UPI","NEFT","cheque","link bhejo","link bhej do",
  "maal","invoice","bill","galat","kam aaya","damaged","dispute","query",
  "already paid","kar diya","ho gaya","nahi mila",
  "mat bhejo","band karo","stop","baat karni hai","manager",
].join(",");

export function sayAndListen(text: string, actionUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" speechModel="experimental_conversations" language="en-IN" enhanced="true" hints="${esc(SPEECH_HINTS)}" action="${esc(actionUrl)}" method="POST" actionOnEmptyResult="true">
    <Say ${VOICE_ATTR}>${esc(text)}</Say>
  </Gather>
</Response>`;
}

export function sayAndHangUp(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say ${VOICE_ATTR}>${esc(text)}</Say>
  <Hangup/>
</Response>`;
}

const SYSTEM = (ctx: VoiceContext): string =>
`You are on a phone call with a buyer about one unpaid invoice, on behalf of an Indian merchant. You are not a debt collector and you do not negotiate.

Invoice: ${spokenAmount(ctx.outstanding)} outstanding, due ${ctx.dueOn}, now ${ctx.daysOverdue} days overdue. Today is ${ctx.today}.

Write every number as Hindi words, never digits: "ek lakh assi hazaar rupaye", not "1,80,000". Your reply is read aloud by a text-to-speech voice, and digits are read in English.

Rules:
- Reply in one or two short sentences. This is spoken aloud, so no lists and no formatting.
- Speak the language they use: Hindi, Hinglish or English.
- If they name a day they will pay, call record_promise with the date resolved to YYYY-MM-DD.
- If they dispute the invoice, call record_dispute and stop. Do not argue or defend the invoice.
- If they want the payment link, call send_payment_link_now.
- If they ask not to be contacted, call set_do_not_call.
- If they are angry, want a person, or anything else unusual, call escalate_to_human.
- Never state an amount other than ${spokenAmount(ctx.outstanding)}, and say it in words, not symbols. Never offer a discount, waiver or instalment plan. Never mention legal action.
- Once you have recorded something, thank them and stop. Do not keep talking.`;

export interface TurnResult { xml: string; toolFired?: string; outcome?: string }

/**
 * One turn: what the buyer said in, TwiML out. The model may call a tool, in
 * which case it runs against the same ledger the WhatsApp path writes to.
 */
export async function handleTurn(
  speech: string,
  confidence: number,
  ctx: VoiceContext,
  store: LedgerStore,
  policy: Policy,
  callSid: string,
  actionUrl: string,
  llm?: Llm,
): Promise<TurnResult> {
  const model = llm ?? gemini({
    apiKey: process.env.GEMINI_API_KEY!,
    cacheDir: null,          // a live call must never replay a cached answer
    minIntervalMs: 0,
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
  });

  if (!speech.trim()) {
    return { xml: sayAndListen("Sorry, main sun nahi paya. Aap kab tak payment kar payenge?", actionUrl) };
  }
  // A transcript the recogniser itself does not believe must not become a
  // promise or a dispute. Ask again rather than act on noise.
  if (confidence > 0 && confidence < 0.4) {
    return { xml: sayAndListen("Maaf kijiye, thoda saaf nahi aaya. Aap dobara bata sakte hain, kab tak payment ho jayega?", actionUrl) };
  }

  let turn;
  try {
    turn = await model.tools({
      system: SYSTEM(ctx),
      prompt: `The buyer just said: "${speech}"`,
      tools: VOICE_TOOLS.map((t) => ({ ...t, parameters: t.parameters as Record<string, unknown> })),
      temperature: 0.3,
    });
  } catch {
    return {
      xml: sayAndHangUp("Maaf kijiye, ek technical dikkat aa gayi. Hum aapko dobara call karenge. Dhanyavaad."),
      toolFired: "error",
    };
  }

  const call: ToolCall | undefined = turn.calls[0];
  if (!call) {
    const reply = turn.text.trim() || "Theek hai. Aap kab tak payment kar payenge?";
    return { xml: sayAndListen(reply, actionUrl) };
  }

  const outcome = await runVoiceTool(call.name, call.args, ctx, store, policy, callSid);
  const spoken = turn.text.trim();

  if (outcome.endCall || call.name === "record_promise" || call.name === "record_dispute") {
    const closing =
      call.name === "record_promise" ? `${spoken || "Theek hai"}. Maine note kar liya hai. Dhanyavaad.`
      : call.name === "record_dispute" ? "Maine aapki baat note kar li hai. Hamari team dekh kar aapse sampark karegi. Dhanyavaad."
      : call.name === "set_do_not_call" ? "Theek hai, hum aapko dobara message nahi karenge. Dhanyavaad."
      : "Theek hai, ek person aapko call karega. Dhanyavaad.";
    return { xml: sayAndHangUp(closing), toolFired: call.name, outcome: outcome.detail };
  }

  const reply = call.name === "send_payment_link_now"
    ? "Maine abhi WhatsApp pe payment link bhej diya hai. Kuch aur poochna hai?"
    : (spoken || "Theek hai.");
  return { xml: sayAndListen(reply, actionUrl), toolFired: call.name, outcome: outcome.detail };
}

export const openingLine = (ctx: VoiceContext): string =>
  `Namaste. Main ${ctx.buyerName} ke liye ek payment reminder ke silsile mein call kar rahi hoon. ` +
  `Ye call record ho rahi hai. ` +
  `Invoice ${spokenAmount(ctx.outstanding)} ka hai, jo ${spokenDays(ctx.daysOverdue)} pehle due ho chuka tha. ` +
  `Aap kab tak payment kar payenge?`;
