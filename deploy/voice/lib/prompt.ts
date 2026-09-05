export interface VoiceContext {
  invoiceId: string;
  buyerName: string;
  buyerPhone: string;
  outstanding: number;
  dueOn: string;
  daysOverdue: number;
  today: string;
  shortUrl?: string;
}

const HI = [
  "shunya","ek","do","teen","chaar","paanch","chhe","saat","aath","nau",
  "das","gyarah","barah","terah","chaudah","pandrah","solah","satrah","atharah","unnees",
  "bees","ikkees","baees","teiys","chaubees","pachchees","chhabbees","sattaees","atthaees","untees",
  "tees","iktees","battees","taintees","chauntees","paintees","chhattees","saintees","adtees","untaalees",
  "chaalees","iktaalees","bayaalees","taintaalees","chavaalees","paintaalees","chhiyaalees","saintaalees","adtaalees","unchaas",
  "pachaas","ikyaavan","baavan","tirpan","chauvan","pachpan","chhappan","sattaavan","atthaavan","unsath",
  "saath","iksath","baasath","tirsath","chausath","paisath","chhiyaasath","sadsath","adsath","unhattar",
  "sattar","ikhattar","bahattar","tihattar","chauhattar","pachhattar","chhihattar","sathattar","athhattar","unaasi",
  "assi","ikyaasi","bayaasi","tirasi","chauraasi","pachaasi","chhiyaasi","sattaasi","atthaasi","nawaasi",
  "nabbe","ikyaanve","baanve","tiraanve","chauraanve","pachaanve","chhiyaanve","sattaanve","atthaanve","ninyaanve",
];

const num = (n: number): string =>
  n < 100 ? (HI[n] ?? String(n))
  : n < 1000 ? `${HI[Math.floor(n / 100)]} sau${n % 100 ? " " + num(n % 100) : ""}`
  : String(n);

/** "ek lakh assi hazaar rupaye". Digits read aloud in English sound like a machine. */
export function spokenAmount(paise: number): string {
  const r = Math.round(paise / 100);
  const lakh = Math.floor(r / 100000), rest = r % 100000;
  const thousand = Math.floor(rest / 1000), units = rest % 1000;
  const parts: string[] = [];
  if (lakh) parts.push(`${num(lakh)} lakh`);
  if (thousand) parts.push(`${num(thousand)} hazaar`);
  if (units) parts.push(num(units));
  return parts.length ? `${parts.join(" ")} rupaye` : "shunya rupaye";
}

export const spokenDays = (n: number): string => `${num(n)} din`;

export const VOICE_TOOLS = [
  { name: "record_promise",
    description: "The buyer committed to paying by a specific date. Only when they named a date.",
    parameters: { type: "object", properties: {
      date: { type: "string", description: "ISO YYYY-MM-DD, resolved against today." },
      note: { type: "string", description: "What they actually said, briefly." } }, required: ["date"] } },
  { name: "record_dispute",
    description: "The buyer is contesting the invoice. Record it and stop. Do not argue.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "send_payment_link_now",
    description: "Send a fresh payment link on WhatsApp while they are on the call.",
    parameters: { type: "object", properties: {} } },
  { name: "set_do_not_call",
    description: "The buyer asked not to be contacted again. Permanent, every channel.",
    parameters: { type: "object", properties: { reason: { type: "string" } } } },
  { name: "escalate_to_human",
    description: "Hand the call to a person: they asked, they are angry, or you are unsure.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];

export function systemInstruction(ctx: VoiceContext): string {
  return `You are a woman from the merchant's accounts team, calling one buyer about one unpaid invoice. You are not a debt collector and you do not negotiate. Use feminine Hindi verb forms throughout: "kar rahi hoon", never "raha".

Open with exactly this, before anything else:
"Namaste, main ${ctx.buyerName} ke liye ek payment reminder ke silsile mein call kar rahi hoon. Ye call record ho rahi hai. Do minute baat kar sakte hain?"

If they say no, thank them and end the call. Do not push.

The invoice:
- Outstanding: ${spokenAmount(ctx.outstanding)}
- Was due: ${ctx.dueOn}, ${spokenDays(ctx.daysOverdue)} ago
- Today is ${ctx.today}

What you are for:
- Ask when they can pay. If they name a day, call record_promise with it resolved to YYYY-MM-DD. "Parso" is two days from today. "Agle hafte Tuesday" is next week's Tuesday, not this week's.
- If they dispute the invoice, call record_dispute and stop. Do not defend it, do not explain why they are wrong.
- If they want the payment link, call send_payment_link_now.
- If they ask not to be called again, call set_do_not_call.
- If they are angry, want a person, or anything else, call escalate_to_human.

How to speak:
- Hindi by default, in the register an Indian buyer uses on the phone. Switch to English only if they clearly speak English. Never start in English.
- Every number as Hindi words. "${spokenDays(ctx.daysOverdue)}", not "${ctx.daysOverdue} days".
- One short sentence at a time. This is a phone call.
- Never repeat a sentence you already said. If she did not hear you, say it shorter and differently.
- Confirm in one line and stop. "Theek hai, maine note kar liya."
- Never state an amount other than ${spokenAmount(ctx.outstanding)}. No discount, no waiver, no instalment plan. Never mention legal action.
- Never claim payment has been received. Only the payment provider knows that.

Timing is not your job. Guards decide when a message may leave. Do not reason about the day or hour.

End the call once you have recorded something or been told no.`;
}
