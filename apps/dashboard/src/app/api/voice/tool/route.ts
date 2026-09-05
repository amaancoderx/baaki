import { baaki, json, policy, store } from "@/lib/server";
import { runVoiceTool } from "@baaki/core";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by the voice bridge, which runs beside Twilio and does not hold the
 * ledger. Only tool effects come this way (a promise recorded, a dispute
 * opened), never audio.
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

  // A date agreed out loud is the least durable thing here: nobody can look it
  // up and the buyer has nothing showing what they agreed to. Put it in writing
  // straight away, with a live link.
  if (outcome.ok && body.name === "record_promise") {
    const on = String(body.args.date ?? body.args.promiseDate ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(on)) {
      try {
        const b = await baaki({ origin: new URL(req.url).origin });
        const confirm = await b.confirmPromise(body.invoiceId, on);
        return json({ ...outcome, confirmation: confirm });
      } catch (e) {
        // The promise is already recorded. Failing to confirm it in writing is
        // worth reporting but is not worth failing the tool call over, which
        // would make the agent think the date was never taken.
        return json({ ...outcome, confirmation: { sent: false, detail: e instanceof Error ? e.message : String(e) } });
      }
    }
  }

  return json(outcome);
}
