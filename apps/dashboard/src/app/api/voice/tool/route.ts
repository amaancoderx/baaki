import { json, policy, store } from "@/lib/server";
import { runVoiceTool } from "@baaki/core";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by the voice bridge, which runs beside Twilio and does not hold the
 * ledger. Only tool effects come this way — a promise recorded, a dispute
 * opened — never audio.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    invoiceId: string; name: string; args: Record<string, unknown>; callSid?: string;
  };
  const p = await policy();
  const s = store();
  const ledger = await s.load(p);

  let c;
  try {
    c = ledger.caseFile(body.invoiceId, Date.now());
  } catch {
    return json({ ok: false, detail: `unknown invoice ${body.invoiceId}` }, 404);
  }

  const outcome = await runVoiceTool(body.name, body.args, {
    invoiceId: body.invoiceId,
    buyerName: c.buyer.name,
    buyerPhone: c.buyer.phone,
    outstanding: c.invoice.amount - c.invoice.amountPaid,
    dueOn: c.invoice.dueOn,
    daysOverdue: c.daysOverdue,
    today: c.today,
    shortUrl: ledger.external(body.invoiceId)?.shortUrl,
  }, s, p, body.callSid ?? "voice");

  return json(outcome);
}
