import { formatINR } from "./money.js";
import { formatCivilShort } from "./time.js";
import type { CaseFile, Persona, Rung } from "./types.js";

/**
 * Deterministic templates. The model rewrites these in the buyer's language at
 * run time, but amounts and dates are always injected from the ledger and never
 * generated, so a hallucinated figure cannot reach a buyer.
 */
export function templateDraft(c: CaseFile, rung: Rung, persona: Persona): string {
  const amt = formatINR(c.invoice.amount - c.invoice.amountPaid);
  const inv = c.invoice.id;
  const name = c.buyer.name;
  const due = formatCivilShort(c.invoice.dueOn);

  switch (rung) {
    case "pre_due":
      return `Hi ${name}, invoice ${inv} for ${amt} is due on ${due}. Payment link is below if you would like to clear it early.`;
    case "whatsapp":
      return `Hi ${name}, invoice ${inv} for ${amt} was due on ${due} and is ${c.daysOverdue} days overdue. You can pay using the link below, or tell us a date that works.`;
    case "whatsapp+reissue":
      return `Hi ${name}, the earlier payment link for invoice ${inv} expired. Here is a fresh one for ${amt}, ${c.daysOverdue} days overdue. If something is holding it up, reply and tell us.`;
    case "owner_whatsapp":
      return `${name}, this is regarding invoice ${inv} for ${amt}, now ${c.daysOverdue} days overdue. We have not heard back on the earlier messages. Could you let us know when this will be settled?`;
    case "human":
      return `Invoice ${inv} for ${amt} is ${c.daysOverdue} days overdue and needs a person to take it forward.`;
  }
}

/** The baseline arm: what a fixed reminder schedule sends today. */
export function baselineDraft(c: CaseFile): string {
  const amt = formatINR(c.invoice.amount - c.invoice.amountPaid);
  return `Reminder: invoice ${c.invoice.id} for ${amt} was due on ${formatCivilShort(c.invoice.dueOn)}. Please make the payment.`;
}
