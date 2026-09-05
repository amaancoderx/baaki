import { baaki, json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // Signature is verified over the exact bytes received. Parsing and
  // re-serialising would reorder keys and change the digest.
  const raw = await req.text();
  const sig = req.headers.get("x-razorpay-signature") ?? undefined;
  const out = await (await baaki()).handleRazorpayWebhook(raw, sig);
  return json(out, out.ok ? 200 : 400);
}
