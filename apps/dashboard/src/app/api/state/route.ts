import { contacts, json, policy, store } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const p = await policy();
  const ledger = await store().load(p);
  const now = Date.now();

  const invoices = ledger.invoices().map((inv) => {
    const c = ledger.caseFile(inv.id, now);
    return {
      invoice: inv,
      buyer: c.buyer,
      memory: c.memory,
      daysOverdue: c.daysOverdue,
      outstanding: inv.amount - inv.amountPaid,
      external: ledger.external(inv.id) ?? {},
      touches: c.touches,
      replies: c.replies,
      payments: c.payments,
      audit: ledger.audit.forInvoice(inv.id),
    };
  });

  return json({ policy: p, invoices, contacts: await contacts() });
}
