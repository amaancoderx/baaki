import type { Buyer, BuyerMemory, Channel, Invoice, Payment, Reply, Touch } from "./types.js";
import { daysBetween } from "./time.js";

const ZERO_BY_CHANNEL = (): Record<Channel, number> => ({ whatsapp: 0, email: 0 });

export function emptyMemory(buyerId: string, language: BuyerMemory["language"] = "hinglish"): BuyerMemory {
  return {
    buyerId,
    avgDaysLate: 0,
    promiseKeptRate: 1,
    disputeRate: 0,
    repliesPerTouch: ZERO_BY_CHANNEL(),
    lastReplyHour: null,
    language,
    doNotContact: false,
    counts: {
      invoices: 0,
      promisesMade: 0,
      promisesKept: 0,
      disputesRaised: 0,
      touches: ZERO_BY_CHANNEL(),
      replies: ZERO_BY_CHANNEL(),
    },
  };
}

/**
 * Memory is arithmetic over the log, recomputed rather than incrementally
 * patched, so the numbers on screen always match the events beneath them.
 */
export function computeMemory(
  buyer: Buyer,
  prior: BuyerMemory,
  invoices: Invoice[],
  touches: Touch[],
  replies: Reply[],
  payments: Map<string, Payment[]>,
): BuyerMemory {
  const counts = {
    invoices: invoices.length,
    promisesMade: 0,
    promisesKept: 0,
    disputesRaised: 0,
    touches: ZERO_BY_CHANNEL(),
    replies: ZERO_BY_CHANNEL(),
  };

  for (const t of touches) counts.touches[t.channel] += 1;
  for (const r of replies) {
    counts.replies[r.channel] += 1;
    if (r.intent === "promise") counts.promisesMade += 1;
    if (r.intent === "dispute") counts.disputesRaised += 1;
  }

  // A promise is kept when a payment landed on or before the promised date.
  for (const r of replies) {
    if (r.intent !== "promise" || !r.promiseDate) continue;
    const pays = payments.get(r.invoiceId) ?? [];
    const paidBy = pays.find((p) => {
      const d = new Date(p.ts).toISOString().slice(0, 10);
      return daysBetween(r.promiseDate!, d) <= 0;
    });
    if (paidBy) counts.promisesKept += 1;
  }

  let lateSum = 0;
  let lateN = 0;
  for (const inv of invoices) {
    const pays = payments.get(inv.id) ?? [];
    if (pays.length === 0) continue;
    const settled = pays[pays.length - 1]!;
    const d = new Date(settled.ts).toISOString().slice(0, 10);
    lateSum += Math.max(0, daysBetween(inv.dueOn, d));
    lateN += 1;
  }

  const lastReply = replies.length ? replies[replies.length - 1]! : null;

  const perTouch = ZERO_BY_CHANNEL();
  for (const ch of ["whatsapp", "email"] as const) {
    perTouch[ch] = counts.touches[ch] === 0 ? 0 : counts.replies[ch] / counts.touches[ch];
  }

  return {
    buyerId: buyer.id,
    avgDaysLate: lateN === 0 ? 0 : lateSum / lateN,
    promiseKeptRate: counts.promisesMade === 0 ? 1 : counts.promisesKept / counts.promisesMade,
    disputeRate: counts.invoices === 0 ? 0 : counts.disputesRaised / counts.invoices,
    repliesPerTouch: perTouch,
    lastReplyHour: lastReply ? new Date(lastReply.ts + 5.5 * 3600_000).getUTCHours() : null,
    language: prior.language,
    doNotContact: prior.doNotContact,
    counts,
  };
}
