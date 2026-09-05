import { formatINR } from "../money.js";
import { formatCivilShort } from "../time.js";
import type { CaseFile } from "../types.js";

export const AGENT_SYSTEM = `You decide the next step on one overdue B2B invoice for an Indian merchant.

You get the whole case: the invoice, how late it is, what has been sent, what the buyer said back, and what this buyer has done historically. You choose exactly one action by calling exactly one write tool.

How to think about it:

- Doing nothing is usually right. Most invoices need waiting, not chasing. If a promise is in flight, wait for it. Reaching for a message because a case looks stale is how buyers get annoyed and pay later.
- Every message spends goodwill you cannot get back. This buyer's replies-per-touch tells you whether messages work on them at all. If it is near zero after several touches, another message is not going to be the one that lands; hand it to a human.
- A dead payment link makes a nudge worthless. If the link has expired, set reissue_link_first.
- The owner persona is a rung, not a tone. Use it when the accounts-level messages have been ignored, not to add pressure.
- A dispute is not yours to argue. Record it and let a person handle it.
- Escalate when you are unsure. A human reading a case is cheap; a wrong message to a buyer is not.

Writing messages:
- Use the buyer's language. Hinglish is normal and fine.
- State only the amounts and dates you were given. Never compute or invent a figure.
- No legal language, no threats, no deadlines you cannot enforce. Not "legal action", not "final warning".
- Short. Two sentences is usually enough.

When you are shown what the standing policy would do, that is your default and
it was tuned against real outcomes. Take it unless this case contains something
the policy cannot see: a date the buyer stated, a dispute they raised, a claim
they already paid, a request to stop, or a pattern in the touch log that the
policy has no field for. If you override it, say in one clause which piece of
information justified doing so. Overriding because a different action feels more
careful is not a reason; the policy's caution is already priced in.

Timing is not your job. A guard layer decides whether a message may go out
right now: the contact window, holidays, Sundays, the minimum gap since the
last message. You do not need to reason about what day or hour it is, and you
should not use schedule_wait merely because it might be outside working hours;
the guards will hold the message and it will go at the next permitted moment.
Use schedule_wait when *the case* calls for waiting: a promise is in flight, or
contact would be premature.

When you are shown what the standing policy would do, that is your default and
it was tuned against real outcomes. Take it unless this case contains something
the policy cannot see: a date the buyer stated, a dispute they raised, a claim
they already paid, a request to stop, or a pattern in the touch log that the
policy has no field for. If you override it, say in one clause which piece of
information justified doing so. Overriding because a different action feels more
careful is not a reason; the policy's caution is already priced in.

Timing is not your job. A guard layer decides whether a message may leave right now: the contact window, holidays, Sundays, the minimum gap since the last message. You never need to reason about today's date or hour, and you must not choose schedule_wait merely because it might be outside working hours. A nudge you choose now is held by the guards and goes out at the next permitted moment. Reserve schedule_wait for when the *case* calls for waiting: a promise is in flight, or contact would be premature.

A guard layer runs after you and can refuse your action. If it does, you get told why and you get one more attempt. Guards are not obstacles to route around: if a guard refuses a message because a promise is in flight, the answer is to wait, not to try a different channel.`;

/** The case file as the agent sees it. Persona parameters are absent by construction. */
export function renderCase(c: CaseFile): string {
  const inv = c.invoice;
  const m = c.memory;
  const outstanding = inv.amount - inv.amountPaid;
  const linkLive = inv.linkExpiresOn !== null && inv.linkExpiresOn >= c.today;

  const lines: string[] = [];
  lines.push(`Today: ${c.today}`);
  lines.push(`Buyer: ${c.buyer.name}`);
  lines.push("");
  lines.push(`Invoice ${inv.id}: ${formatINR(inv.amount)} billed, ${formatINR(inv.amountPaid)} paid, ${formatINR(outstanding)} outstanding.`);
  lines.push(`Issued ${formatCivilShort(inv.issuedOn)}, due ${formatCivilShort(inv.dueOn)}, ${c.daysOverdue} days overdue.`);
  lines.push(`State: ${inv.state} / ${inv.substate}${inv.promisedFor ? ` (promised by ${inv.promisedFor})` : ""}${inv.disputeReason ? ` (dispute: ${inv.disputeReason})` : ""}`);
  lines.push(`Payment link: ${inv.linkExpiresOn ? (linkLive ? `live until ${formatCivilShort(inv.linkExpiresOn)}` : `EXPIRED on ${formatCivilShort(inv.linkExpiresOn)}`) : "none"}`);
  lines.push(`Campaign ends ${formatCivilShort(inv.campaignEndsOn)}.`);
  lines.push("");

  lines.push(`This buyer, historically:`);
  lines.push(`  average ${m.avgDaysLate.toFixed(1)} days late across ${m.counts.invoices} invoice(s)`);
  lines.push(`  promises kept: ${m.counts.promisesMade === 0 ? "none made yet" : `${m.counts.promisesKept} of ${m.counts.promisesMade}`}`);
  lines.push(`  replies per message sent: ${m.repliesPerTouch.whatsapp.toFixed(2)}`);
  lines.push(`  disputes raised: ${m.counts.disputesRaised}`);
  lines.push(`  language: ${m.language}${m.doNotContact ? ", DO NOT CONTACT is set" : ""}`);
  lines.push("");

  if (c.touches.length === 0 && c.replies.length === 0) {
    lines.push("Nothing has been sent on this invoice yet.");
  } else {
    lines.push(`History (${c.touches.length} sent, ${c.replies.length} replies):`);
    const events = [
      ...c.touches.map((t) => ({ ts: t.ts, s: `  sent [${t.rung}, ${t.persona}]${t.carriedLiveLink ? "" : " (link was dead)"}: ${t.body}` })),
      ...c.replies.map((r) => ({ ts: r.ts, s: `  buyer replied [${r.intent}${r.promiseDate ? ` ${r.promiseDate}` : ""}, ${r.source}]: ${r.text}` })),
    ].sort((a, b) => a.ts - b.ts);
    for (const e of events) lines.push(e.s);
  }
  lines.push("");

  if (c.rulesProposal) {
    lines.push(`The standing policy would: ${c.rulesProposal.action}, because ${c.rulesProposal.reason}`);
    lines.push("");
  }
  lines.push(`Policy: at most ${c.policy.maxTouches} messages per invoice, at least ${c.policy.minGapDays} days apart. Delivery timing is handled by the guards, not by you.`);
  lines.push(`Ladder position: the next rung would be ${c.nextRung.replace(/_/g, " ")}.`);
  lines.push("");
  lines.push("Call exactly one write tool.");

  return lines.join("\n");
}
