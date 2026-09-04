import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta WhatsApp Cloud API.
 *
 * Two ways to reach a buyer, and the difference is a compliance rule rather
 * than a style choice: outside a 24-hour window from the buyer's last inbound
 * message only an approved template may be sent; inside it, free-form is
 * allowed. The `whatsapp_24h_window` guard enforces this before anything here
 * is called.
 */

export interface WhatsappConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Verifies inbound webhook signatures. */
  appSecret?: string;
  /** Echoed back on Meta's GET subscription handshake. */
  verifyToken?: string;
  apiVersion?: string;
  /** Set for a dry run: logs what would be sent and returns a fake id. */
  dryRun?: boolean;
}

export interface SendResult {
  messageId: string;
  to: string;
  kind: "template" | "text" | "interactive";
  dryRun: boolean;
}

export interface TemplateSend {
  to: string;
  template: string;
  language?: string;
  /** Positional {{1}}, {{2}}, … body variables. */
  bodyParams: string[];
  /** Suffix appended to the template's URL button base. */
  urlButtonSuffix?: string;
}

export class WhatsappError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: unknown) {
    super(message);
    this.name = "WhatsappError";
  }
}

export interface InboundMessage {
  messageId: string;
  from: string;
  timestamp: number;
  /** Button payloads carry their meaning exactly; free text has to be read. */
  source: "button" | "free_text";
  text: string;
  /** Present when the buyer tapped a quick reply. */
  buttonPayload?: string;
  contactName?: string;
}

export interface InboundStatus {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: number;
  recipient: string;
  error?: string;
}

export function whatsapp(cfg: WhatsappConfig) {
  const version = cfg.apiVersion ?? "v21.0";
  const base = `https://graph.facebook.com/${version}`;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = json.error as { message?: string; error_user_msg?: string } | undefined;
      throw new WhatsappError(err?.error_user_msg ?? err?.message ?? `HTTP ${res.status}`, res.status, json);
    }
    return json;
  }

  const idOf = (json: Record<string, unknown>): string => {
    const msgs = json.messages as { id?: string }[] | undefined;
    return msgs?.[0]?.id ?? "unknown";
  };

  return {
    /** Approved template. The only thing that may be sent outside the 24h window. */
    async sendTemplate(t: TemplateSend): Promise<SendResult> {
      const components: Record<string, unknown>[] = [];
      if (t.bodyParams.length) {
        components.push({
          type: "body",
          parameters: t.bodyParams.map((text) => ({ type: "text", text })),
        });
      }
      if (t.urlButtonSuffix !== undefined) {
        components.push({
          type: "button", sub_type: "url", index: "0",
          parameters: [{ type: "text", text: t.urlButtonSuffix }],
        });
      }
      const body = {
        messaging_product: "whatsapp",
        to: t.to,
        type: "template",
        template: {
          name: t.template,
          language: { code: t.language ?? "en" },
          ...(components.length ? { components } : {}),
        },
      };
      if (cfg.dryRun) {
        return { messageId: `dry_${t.template}_${Date.now()}`, to: t.to, kind: "template", dryRun: true };
      }
      return { messageId: idOf(await post(`${cfg.phoneNumberId}/messages`, body)), to: t.to, kind: "template", dryRun: false };
    },

    /** Free-form. Legal only inside the 24-hour session window. */
    async sendText(to: string, text: string): Promise<SendResult> {
      const body = {
        messaging_product: "whatsapp", to, type: "text",
        text: { preview_url: true, body: text },
      };
      if (cfg.dryRun) return { messageId: `dry_text_${Date.now()}`, to, kind: "text", dryRun: true };
      return { messageId: idOf(await post(`${cfg.phoneNumberId}/messages`, body)), to, kind: "text", dryRun: false };
    },

    /** Free-form message with quick replies. Also session-window only. */
    async sendButtons(to: string, text: string, buttons: { id: string; title: string }[]): Promise<SendResult> {
      const body = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      };
      if (cfg.dryRun) return { messageId: `dry_btn_${Date.now()}`, to, kind: "interactive", dryRun: true };
      return { messageId: idOf(await post(`${cfg.phoneNumberId}/messages`, body)), to, kind: "interactive", dryRun: false };
    },

    async markRead(messageId: string): Promise<void> {
      if (cfg.dryRun) return;
      await post(`${cfg.phoneNumberId}/messages`, {
        messaging_product: "whatsapp", status: "read", message_id: messageId,
      });
    },

    /** Meta's GET handshake. Returns the challenge to echo, or null to reject. */
    verifySubscription(query: Record<string, string | undefined>): string | null {
      if (query["hub.mode"] !== "subscribe") return null;
      if (!cfg.verifyToken || query["hub.verify_token"] !== cfg.verifyToken) return null;
      return query["hub.challenge"] ?? null;
    },

    /**
     * X-Hub-Signature-256 over the raw body. Compared in constant time, and
     * against the raw bytes rather than a re-serialised object, since any
     * key reordering would change the digest.
     */
    verifySignature(rawBody: string | Buffer, header: string | undefined): boolean {
      if (!cfg.appSecret) return true;
      if (!header?.startsWith("sha256=")) return false;
      const expected = createHmac("sha256", cfg.appSecret).update(rawBody).digest("hex");
      const got = header.slice("sha256=".length);
      if (got.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
    },

    config: cfg,
  };
}

export type WhatsappClient = ReturnType<typeof whatsapp>;

/** Pulls messages and delivery statuses out of a Cloud API webhook payload. */
export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: InboundStatus[] } {
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];
  const body = payload as {
    entry?: { changes?: { value?: {
      contacts?: { profile?: { name?: string }; wa_id?: string }[];
      messages?: Record<string, any>[];
      statuses?: Record<string, any>[];
    } }[] }[];
  };

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;
      const contactName = v.contacts?.[0]?.profile?.name;

      for (const m of v.messages ?? []) {
        const ts = Number(m.timestamp) * 1000;
        if (m.type === "button") {
          messages.push({ messageId: m.id, from: m.from, timestamp: ts, source: "button", text: String(m.button?.text ?? ""), buttonPayload: String(m.button?.payload ?? m.button?.text ?? ""), contactName });
        } else if (m.type === "interactive" && m.interactive?.button_reply) {
          const br = m.interactive.button_reply;
          messages.push({ messageId: m.id, from: m.from, timestamp: ts, source: "button", text: String(br.title ?? ""), buttonPayload: String(br.id ?? br.title ?? ""), contactName });
        } else if (m.type === "text") {
          messages.push({ messageId: m.id, from: m.from, timestamp: ts, source: "free_text", text: String(m.text?.body ?? ""), contactName });
        } else {
          // Media, location, reaction: recorded so the timeline is complete,
          // but there is nothing to parse and nothing that moves the ledger.
          messages.push({ messageId: m.id, from: m.from, timestamp: ts, source: "free_text", text: `[${m.type}]`, contactName });
        }
      }

      for (const s of v.statuses ?? []) {
        statuses.push({
          messageId: s.id, status: s.status, timestamp: Number(s.timestamp) * 1000,
          recipient: s.recipient_id,
          error: s.errors?.[0]?.title ?? s.errors?.[0]?.message,
        });
      }
    }
  }
  return { messages, statuses };
}

/** Maps a quick-reply payload onto a ledger intent. No model involved. */
export function buttonIntent(payload: string): "already_paid" | "dispute" | "stop" | "will_pay" | "unclear" {
  const p = payload.toLowerCase().trim();
  if (p.includes("already paid") || p.includes("paid")) return "already_paid";
  if (p.includes("query") || p.includes("dispute") || p.includes("raise")) return "dispute";
  if (p.includes("stop") || p.includes("opt out")) return "stop";
  if (p.includes("pay on") || p.includes("date")) return "will_pay";
  return "unclear";
}

/** Opt-out keywords a buyer might send as free text, in English and Hinglish. */
const STOP_WORDS = [
  "stop", "unsubscribe", "opt out", "optout",
  "mat bhejo", "band karo", "mat karo", "pareshan mat",
  "don't message", "dont message", "do not message", "no more messages",
];

export function isOptOut(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t === "stop") return true;
  return STOP_WORDS.some((w) => t.includes(w));
}
