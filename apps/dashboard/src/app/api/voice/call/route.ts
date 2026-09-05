import { json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Places an outbound call. Kept server-side so Twilio credentials never reach
 * the browser, and so the TwiML URL is always this deployment's own origin.
 */
export async function POST(req: Request) {
  const { invoiceId, to } = (await req.json()) as { invoiceId: string; to?: string };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return json({ error: "twilio is not configured" }, 400);

  const origin = new URL(req.url).origin;
  const body = new URLSearchParams({
    To: to ?? "",
    From: from,
    Url: `${origin}/api/voice/answer?invoice=${encodeURIComponent(invoiceId)}`,
    Record: "true",
    Timeout: "30",
  });
  if (!body.get("To")) return json({ error: "no number to call" }, 400);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const out = (await res.json()) as Record<string, unknown>;
  if (!res.ok) return json({ error: out.message ?? `twilio ${res.status}` }, 400);
  return json({ sid: out.sid, status: out.status, to: out.to });
}
