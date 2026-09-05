import { createHash } from "node:crypto";
import type { CaseFile } from "../types.js";

/**
 * A canonical fingerprint of everything the agent is allowed to reason about.
 *
 * Two cases with the same hash are the same question, so the answer can be
 * reused. Keying on the invoice id and the date instead would make every run a
 * fresh spend and make reruns unreproducible; keying on the full rendered
 * prompt would include the buyer's name and defeat sharing between identical
 * situations.
 *
 * Deliberately excluded: the invoice id, the buyer name, and today's date.
 * Deliberately included: anything that would change the right answer.
 */
export function caseHash(c: CaseFile): string {
  const inv = c.invoice;
  const lastReply = c.replies[c.replies.length - 1];
  const lastTouch = c.touches[c.touches.length - 1];

  const bucket = (n: number) => (n <= 7 ? "0-7" : n <= 14 ? "8-14" : n <= 30 ? "15-30" : n <= 60 ? "31-60" : "61+");
  const days = (from: string | null | undefined) =>
    from ? Math.round((Date.parse(c.today + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000) : null;

  const shape = {
    overdue: bucket(c.daysOverdue),
    state: inv.state,
    substate: inv.substate,
    // Relative, not absolute: "promised, 3 days out" is the same question
    // whoever the buyer is and whatever the calendar says.
    promiseIn: inv.promisedFor ? -(days(inv.promisedFor) ?? 0) : null,
    linkLive: inv.linkExpiresOn ? inv.linkExpiresOn >= c.today : false,
    touches: c.touches.length,
    replies: c.replies.length,
    rung: c.nextRung,
    daysSinceTouch: lastTouch ? days(new Date(lastTouch.ts + 5.5 * 3600_000).toISOString().slice(0, 10)) : null,
    lastIntent: lastReply?.intent ?? null,
    lastSource: lastReply?.source ?? null,
    lowConfidence: lastReply ? lastReply.confidence < c.policy.minParseConfidence : false,
    // Memory, bucketed: the exact rate does not change the decision, the
    // rough shape does.
    everReplied: c.memory.counts.replies.whatsapp > 0,
    promisesKept: c.memory.counts.promisesMade === 0 ? "none"
      : c.memory.promiseKeptRate >= 0.7 ? "high" : c.memory.promiseKeptRate >= 0.35 ? "mid" : "low",
    dnc: c.memory.doNotContact,
    campaignOver: inv.campaignEndsOn < c.today,
    policy: c.policy.policyVersion,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 24);
}
