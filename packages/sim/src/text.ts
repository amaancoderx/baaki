import type { Rng } from "./rng.js";
import type { ReplyDraw } from "./buyer.js";

/**
 * Renders the surface text of a reply whose intent was already sampled by the
 * rules. Deterministic and cached by intent, per plan §6.5: the model has no
 * say in what the buyer means, only in how it reads. Live mode swaps this for
 * a Gemini call; headless runs use these so seeds stay reproducible and free.
 */
const BANK: Record<string, string[]> = {
  promise: [
    "Ramesh ko bolta hoon, {date} tak ho jayega",
    "payment {date} ko kar denge, thoda cash flow issue tha",
    "will clear it by {date}, please bear with us",
    "{date} tak transfer kar dunga pakka",
    "accounts se bola hai, {date} ko release hoga",
  ],
  dispute: [
    "{reason}",
    "ek problem hai - {reason}",
    "before paying, {reason}",
  ],
  will_pay: [
    "haan dekhta hoon",
    "ok noted",
    "will check with accounts",
    "theek hai, processing mein hai",
  ],
  already_paid: [
    "payment already kar diya tha, check karo",
    "we transferred last week, please confirm",
  ],
  partial: [
    "half amount bhej diya hai, baaki next week",
    "partial payment done, rest is pending",
  ],
  stop: [
    "mat bhejo baar baar",
    "STOP",
    "please stop messaging, we will pay when we pay",
  ],
  unclear: [
    "?",
    "kaun bol raha hai",
    "ye kis cheez ka hai",
    "call me",
  ],
};

export function renderReply(draw: ReplyDraw, rng: Rng): string {
  const options = BANK[draw.intent] ?? BANK.unclear!;
  const t = rng.pick(options);
  return t
    .replace("{date}", draw.promiseDate ?? "")
    .replace("{reason}", draw.disputeReason ?? "");
}
