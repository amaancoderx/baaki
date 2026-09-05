import { timingSafeEqual } from "node:crypto";
import { baaki, json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Inbound email, from whichever service routes the mailbox.
 *
 * Accepts the two shapes the common routers deliver: a JSON body with
 * from / subject / text (Cloudflare Email Workers, custom forwarders) and
 * multipart form data with the same field names (SendGrid Inbound Parse).
 * Authenticated by a shared token, because unlike Meta and Razorpay the
 * inbound-mail ecosystem has no one signature scheme to verify.
 */
function authorized(req: Request): boolean {
  const expected = process.env.EMAIL_INBOUND_TOKEN;
  if (!expected) return false;
  const got = new URL(req.url).searchParams.get("token")
    ?? req.headers.get("x-inbound-token") ?? "";
  return got.length === expected.length
    && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export async function POST(req: Request) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  let from = "", subject = "", text = "", messageId: string | undefined;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = (await req.json()) as Record<string, string>;
    from = b.from ?? ""; subject = b.subject ?? ""; text = b.text ?? b.body ?? "";
    messageId = b.messageId ?? b["message-id"];
  } else {
    const form = await req.formData();
    from = String(form.get("from") ?? "");
    subject = String(form.get("subject") ?? "");
    text = String(form.get("text") ?? "");
    const headers = String(form.get("headers") ?? "");
    messageId = /^Message-ID:\s*(.+)$/mi.exec(headers)?.[1]?.trim();
  }

  if (!from || !text) return json({ error: "from and text are required" }, 400);

  const b = await baaki();
  const out = await b.handleInboundEmail({ from, subject, text, messageId });
  return json(out, out.ok ? 200 : 202);
}
