/**
 * Outbound email in Baaki's own words.
 *
 * Razorpay's notify sends its branded reminder, which is reach but not voice:
 * the text cannot be ours. This sender carries the same drafted message the
 * WhatsApp does, from an address the merchant owns, which is also what makes
 * replies readable: mail sent from our domain can be routed back into
 * /api/webhooks/email, closing the loop Razorpay's no-reply cannot.
 *
 * Resend's HTTP API, no SDK. Configured entirely by environment; absent
 * configuration means the caller falls back to Razorpay notify, so nothing
 * here is required for the system to run.
 */

export interface EmailSender {
  send(m: { to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

export function emailSender(cfg: { apiKey: string; from: string }): EmailSender {
  return {
    async send(m) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, text: m.text }),
      });
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) throw new Error(json.message ?? `resend ${res.status}`);
      return { messageId: json.id ?? "sent" };
    },
  };
}
