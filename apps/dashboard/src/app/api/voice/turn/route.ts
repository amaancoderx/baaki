import { handleTurn, sayAndHangUp } from "@baaki/core";
import { policy, store } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const xml = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" } });

/** One turn: what Twilio heard in, TwiML out. */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const invoiceId = url.searchParams.get("invoice") ?? "";
  const form = Object.fromEntries(new URLSearchParams(await req.text()));
  const speech = form.SpeechResult ?? "";
  const confidence = Number(form.Confidence ?? 0);
  const callSid = form.CallSid ?? "twilio";

  try {
    const p = await policy();
    const s = store();
    const ledger = await s.load(p);
    const c = ledger.caseFile(invoiceId, Date.now());
    const ctx = {
      invoiceId,
      buyerName: c.buyer.name,
      buyerPhone: c.buyer.phone,
      outstanding: c.invoice.amount - c.invoice.amountPaid,
      dueOn: c.invoice.dueOn,
      daysOverdue: c.daysOverdue,
      today: c.today,
      shortUrl: ledger.external(invoiceId)?.shortUrl,
    };
    const action = `${url.origin}/api/voice/turn?invoice=${encodeURIComponent(invoiceId)}`;
    const r = await handleTurn(speech, confidence, ctx, s, p, callSid, action);
    return xml(r.xml);
  } catch (e) {
    console.error("voice turn failed", e);
    return xml(sayAndHangUp("Maaf kijiye, ek dikkat aa gayi. Dhanyavaad."));
  }
}
