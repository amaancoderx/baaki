import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({
    ok: true,
    razorpay: Boolean(process.env.RAZORPAY_KEY_ID),
    razorpayWebhookSecret: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    whatsapp: Boolean(process.env.WA_ACCESS_TOKEN),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    redis: Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL),
  });
}
