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
    const b = (await req.json()) as Record<string, unknown>;
    // Resend's email.received event nests the message under data.
    const data = (b.type === "email.received" && b.data && typeof b.data === "object"
      ? b.data : b) as Record<string, string>;
    from = String(data.from ?? "");
    subject = String(data.subject ?? "");
    text = String(data.text ?? data.body ?? "");
    messageId = (data.email_id ?? data.message_id ?? data.messageId) as string | undefined;

    // The event announces the mail; the body lives behind one more fetch.
    // Requiring text on the event itself meant every genuine reply arrived,
    // was acknowledged, and was thrown away with a 400.
    const key = process.env.RESEND_API_KEY;
    if (!text && messageId && key && b.type === "email.received") {
      const full = await fetch(`https://api.resend.com/emails/receiving/${messageId}`, {
        headers: { Authorization: `Bearer ${key}` },
      }).then((r) => r.json()).catch(() => null) as Record<string, string> | null;
      if (full) {
        from = from || String(full.from ?? "");
        subject = subject || String(full.subject ?? "");
        text = String(full.text ?? "") || String(full.html ?? "")
          .replace(/<br\s*\/?>(?=.)/gi, "\n").replace(/<\/(p|div)>/gi, "\n")
          .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      }
    }
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
