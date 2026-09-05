import { baaki, contacts, json } from "@/lib/server";
import { rupees } from "@baaki/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json()) as {
    contactId: string; amountRupees: number; description?: string;
    termDays?: number; linkValidDays?: number; issuedDaysAgo?: number;
  };
  const contact = (await contacts()).find((c) => c.id === body.contactId);
  if (!contact) return json({ error: `no contact ${body.contactId}` }, 404);

  const out = await (await baaki()).createInvoice({
    contact,
    amount: rupees(body.amountRupees),
    description: body.description ?? `Supply against PO for ${contact.name}`,
    termDays: body.termDays ?? contact.termDays,
    linkValidDays: body.linkValidDays,
    issuedDaysAgo: body.issuedDaysAgo,
    createVirtualAccount: true,
  });
  return json(out);
}
