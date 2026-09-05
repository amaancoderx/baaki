import { openingLine, sayAndHangUp, sayAndListen } from "@baaki/core";
import { policy, store } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const xml = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" } });

/** Twilio fetches this when the call connects. */
export async function POST(req: Request) {
  return answer(req);
}
export async function GET(req: Request) {
  return answer(req);
}

async function answer(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const invoiceId = url.searchParams.get("invoice") ?? "";
  try {
    const p = await policy();
    const ledger = await store().load(p);
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
    // Real-time by default: Gemini hears the caller directly and answers in
    // its own voice. VOICE_MODE=gather falls back to Twilio's TTS and
    // recogniser, which work anywhere but sound synthetic and mangle Hindi.
    if ((process.env.VOICE_MODE ?? "live") === "live") {
      const wss = url.origin.replace(/^https/, "wss");
      return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wss}/api/ws">
      <Parameter name="invoice" value="${invoiceId}" />
    </Stream>
  </Connect>
</Response>`);
    }

    const action = `${url.origin}/api/voice/turn?invoice=${encodeURIComponent(invoiceId)}`;
    return xml(sayAndListen(openingLine(ctx), action));
  } catch {
    return xml(sayAndHangUp("Maaf kijiye, is invoice ki jaankari nahi mili. Dhanyavaad."));
  }
}
