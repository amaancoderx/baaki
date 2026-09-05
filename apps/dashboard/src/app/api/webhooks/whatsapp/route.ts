import { baaki, json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Meta's subscription handshake: echo the challenge or refuse. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  if (q.get("hub.mode") !== "subscribe") return new Response("forbidden", { status: 403 });
  if (q.get("hub.verify_token") !== process.env.WA_VERIFY_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  return new Response(q.get("hub.challenge") ?? "", {
    status: 200, headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256") ?? undefined;
  const out = await (await baaki()).handleWhatsappWebhook(raw, sig);
  // Always 200: Meta retries hard on anything else, and a bad signature is not
  // something a retry can fix.
  return json(out);
}
