import { createHmac, timingSafeEqual } from "node:crypto";
import { clock, json, policy, store } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Twilio's word on how a call ended.
 *
 * The trail used to record that a call was placed and then nothing, so an
 * unanswered call was indistinguishable from a conversation. The outcome is
 * written from the provider's own status callback, signature verified the same
 * way the payment webhooks are: nobody else gets to say what happened on a
 * phone line, including us.
 */
export async function POST(req: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return json({ error: "not configured" }, 400);

  const raw = await req.text();
  const params = new URLSearchParams(raw);

  // X-Twilio-Signature: HMAC-SHA1 over the full URL plus the sorted form body.
  const url = `${new URL(req.url).origin}/api/voice/status`;
  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const payload = url + sorted.map(([k, v]) => k + v).join("");
  const expected = createHmac("sha1", token).update(payload).digest("base64");
  const got = req.headers.get("x-twilio-signature") ?? "";
  const ok = got.length === expected.length
    && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return json({ error: "bad signature" }, 403);

  const sid = params.get("CallSid") ?? "";
  const status = params.get("CallStatus") ?? "unknown";
  const duration = Number(params.get("CallDuration") ?? 0);
  if (!sid) return json({ error: "no CallSid" }, 400);

  const p = await policy();
  const now = (await clock()).now();

  await store().update((ledger) => {
    // The call already carries its SID in the trail; the outcome attaches to
    // the same invoice.
    for (const inv of ledger.invoices()) {
      const placed = ledger.audit.forInvoice(inv.id)
        .find((e) => e.action === "place_call" && e.params.callSid === sid);
      if (!placed) continue;
      const answered = status === "completed" && duration > 0;
      ledger.audit.append({
        ts: now, invoiceId: inv.id, actor: "webhook", action: "none",
        params: { callOutcome: status, callSid: sid, durationSeconds: duration },
        rationale: answered
          ? `The call connected and lasted ${duration} seconds. Anything agreed on it is recorded by its own entries.`
          : `The call went unanswered (${status}). The buyer has still not been reached.`,
        guards: [], policyVersion: p.policyVersion, evidence: [sid],
      });
      break;
    }
    return null;
  }, p);

  return json({ ok: true });
}
