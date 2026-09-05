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
  send(m: { to: string; subject: string; text: string; html?: string }): Promise<{ messageId: string }>;
}

export function emailSender(cfg: { apiKey: string; from: string }): EmailSender {
  return {
    async send(m) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
      });
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) throw new Error(json.message ?? `resend ${res.status}`);
      return { messageId: json.id ?? "sent" };
    },
  };
}

/**
 * The follow-up email, dressed for an inbox.
 *
 * One column, inline styles only, no images: the design survives every mail
 * client and the message reads even with HTML off, since the text part always
 * travels alongside. The tone matches the WhatsApp: the drafted words are the
 * body, the amount is unmissable, and the link is a button rather than a URL
 * to squint at.
 */
export function renderEmailHtml(input: {
  bodyText: string;
  buyerName: string;
  invoiceId: string;
  amountLabel: string;
  dueLabel: string;
  link?: string;
}): string {
  const paras = input.bodyText
    .split(/\n{2,}/)
    .map((b) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#26251f;">${b.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f3ef;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ef;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e7e5de;overflow:hidden;">
  <tr><td style="padding:22px 28px;border-bottom:1px solid #efede7;">
    <span style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:#1c1b16;">Baaki</span>
    <span style="float:right;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a877d;padding-top:6px;">${input.invoiceId}</span>
  </td></tr>
  <tr><td style="padding:26px 28px 6px;font-family:Arial,Helvetica,sans-serif;">
    ${paras}
  </td></tr>
  <tr><td style="padding:8px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f6;border:1px solid #efede7;border-radius:10px;">
      <tr>
        <td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;">
          <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a877d;">Amount due</div>
          <div style="font-size:22px;font-weight:700;color:#1c1b16;margin-top:2px;">${input.amountLabel}</div>
        </td>
        <td align="right" style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;">
          <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a877d;">Due date</div>
          <div style="font-size:15px;color:#1c1b16;margin-top:6px;">${input.dueLabel}</div>
        </td>
      </tr>
    </table>
  </td></tr>
  ${input.link ? `<tr><td align="center" style="padding:22px 28px 6px;">
    <a href="${input.link}" style="display:inline-block;background:#0e5e54;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:13px 34px;border-radius:8px;">Pay now</a>
  </td></tr>
  <tr><td align="center" style="padding:4px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a877d;">
    or use this link: <a href="${input.link}" style="color:#0e5e54;">${input.link}</a>
  </td></tr>` : ""}
  <tr><td style="padding:22px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a877d;line-height:1.6;">
    Reply to this email and it reaches us directly. Agar aap payment kar chuke hain, to is email ko ignore kar dein.
  </td></tr>
</table>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#a5a297;padding-top:14px;">Sent by Baaki on behalf of the merchant · baaki.xyz</div>
</td></tr></table>
</body></html>`;
}
