import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import {
  loadContacts, rupees, upsertContact, type Contact,
} from "@baaki/core";
import { buildBaaki, loadPolicy, savePolicy } from "./config.js";

const PORT = Number(process.env.WEBHOOK_PORT ?? 3001);
const CONTACTS = "data/contacts.json";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(s);
};

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  try {
    // -- Meta's subscription handshake -------------------------------------
    if (path === "/webhooks/whatsapp" && req.method === "GET") {
      const baaki = buildBaaki();
      const q = Object.fromEntries(url.searchParams.entries());
      const challenge = (baaki as unknown as { cfg: { whatsapp?: { verifySubscription(q: Record<string, string | undefined>): string | null } } })
        .cfg.whatsapp?.verifySubscription(q) ?? null;
      if (challenge === null) {
        log("whatsapp verify REJECTED", q["hub.mode"]);
        res.writeHead(403); return res.end("forbidden");
      }
      log("whatsapp verify OK");
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(challenge);
    }

    if (path === "/webhooks/whatsapp" && req.method === "POST") {
      const raw = await readBody(req);
      const baaki = buildBaaki();
      const out = await baaki.handleWhatsappWebhook(raw, req.headers["x-hub-signature-256"] as string | undefined);
      log("whatsapp inbound", out.ok ? `handled ${out.handled}` : `REJECTED ${out.reason}`);
      // Always 200: Meta retries aggressively on anything else, and a rejected
      // signature is not something a retry will fix.
      return json(res, 200, out);
    }

    if (path === "/webhooks/razorpay" && req.method === "POST") {
      const raw = await readBody(req);
      const baaki = buildBaaki();
      const out = await baaki.handleRazorpayWebhook(raw, req.headers["x-razorpay-signature"] as string | undefined);
      log("razorpay inbound", out.ok ? `event ${out.event?.event}` : `REJECTED ${out.reason}`);
      return json(res, out.ok ? 200 : 400, out);
    }

    // -- app API ------------------------------------------------------------
    if (path === "/api/state" && req.method === "GET") {
      const baaki = buildBaaki();
      const ledger = baaki.store.load(loadPolicy());
      const invoices = ledger.invoices().map((inv) => {
        const c = ledger.caseFile(inv.id, Date.now());
        return {
          invoice: inv,
          buyer: c.buyer,
          memory: c.memory,
          daysOverdue: c.daysOverdue,
          outstanding: inv.amount - inv.amountPaid,
          external: ledger.external(inv.id) ?? {},
          touches: c.touches,
          replies: c.replies,
          payments: c.payments,
          audit: ledger.audit.forInvoice(inv.id),
        };
      });
      return json(res, 200, { policy: loadPolicy(), invoices, contacts: loadContacts(CONTACTS) });
    }

    if (path === "/api/contacts" && req.method === "GET") {
      return json(res, 200, { contacts: loadContacts(CONTACTS) });
    }

    if (path === "/api/contacts" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Partial<Contact>;
      if (!body.name || !body.phone) return json(res, 400, { error: "name and phone are required" });
      const contact: Contact = {
        id: body.id ?? `c_live_${Date.now().toString(36)}`,
        name: body.name,
        phone: body.phone.replace(/\D/g, ""),
        email: body.email,
        city: body.city ?? "—",
        termDays: body.termDays ?? 30,
        language: body.language ?? "hinglish",
        sendable: body.sendable ?? true,
        notes: body.notes ?? "Added from the dashboard. WhatsApp will deliver if Meta has this number registered.",
      };
      return json(res, 200, { contacts: upsertContact(CONTACTS, contact), contact });
    }

    if (path === "/api/policy" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const next = savePolicy(body);
      log("policy updated", Object.keys(body).join(", "));
      return json(res, 200, { policy: next });
    }

    if (path === "/api/invoices" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        contactId: string; amountRupees: number; description?: string;
        termDays?: number; linkValidDays?: number; issuedDaysAgo?: number;
      };
      const contact = loadContacts(CONTACTS).find((c) => c.id === body.contactId);
      if (!contact) return json(res, 404, { error: `no contact ${body.contactId}` });

      const baaki = buildBaaki();
      const out = await baaki.createInvoice({
        contact,
        amount: rupees(body.amountRupees),
        description: body.description ?? `Supply against PO for ${contact.name}`,
        termDays: body.termDays ?? contact.termDays,
        linkValidDays: body.linkValidDays,
        issuedDaysAgo: body.issuedDaysAgo,
        createVirtualAccount: true,
      });
      log("invoice created", out.invoice.id, contact.name, out.razorpay?.shortUrl ?? "(no rzp)");
      return json(res, 200, out);
    }

    // Executed by the voice bridge when it runs in another region.
    if (path === "/api/voice/tool" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        invoiceId: string; name: string; args: Record<string, unknown>; callSid?: string;
      };
      const { runVoiceTool, LedgerStore } = await import("@baaki/core");
      const policy = loadPolicy();
      const store = new LedgerStore("data/ledger.json");
      const ledger = store.load(policy);
      const c = ledger.caseFile(body.invoiceId, Date.now());
      const ctx = {
        invoiceId: body.invoiceId,
        buyerName: c.buyer.name,
        buyerPhone: c.buyer.phone,
        outstanding: c.invoice.amount - c.invoice.amountPaid,
        dueOn: c.invoice.dueOn,
        daysOverdue: c.daysOverdue,
        today: c.today,
        shortUrl: ledger.external(body.invoiceId)?.shortUrl,
      };
      const outcome = await runVoiceTool(body.name, body.args, ctx, store, policy, body.callSid ?? "remote");
      log(`voice tool ${body.name} (${body.invoiceId}) -> ${outcome.detail}`);
      return json(res, 200, outcome);
    }

    if (path === "/api/tick" && req.method === "POST") {
      const baaki = buildBaaki();
      const report = await baaki.tick();
      log(`tick: ${report.considered} considered, ${report.fastCount} rules, ${report.slowCount} agent, ${report.sentCount} sent, ${report.blockedCount} blocked`);
      return json(res, 200, report);
    }

    if (path === "/api/audit" && req.method === "GET") {
      const baaki = buildBaaki();
      const fmt = url.searchParams.get("format") === "csv" ? "csv" : "json";
      const body = await baaki.auditExport(fmt);
      res.writeHead(200, {
        "Content-Type": fmt === "csv" ? "text/csv" : "application/json",
        "Content-Disposition": `attachment; filename="baaki-audit.${fmt}"`,
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(body);
    }

    if (path === "/health") {
      return json(res, 200, {
        ok: true,
        razorpay: Boolean(process.env.RAZORPAY_KEY_ID),
        whatsapp: Boolean(process.env.WA_ACCESS_TOKEN),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        webhookSecret: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
      });
    }

    json(res, 404, { error: `no route ${req.method} ${path}` });
  } catch (e) {
    log("ERROR", e instanceof Error ? e.stack : e);
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  log(`baaki webhook service on :${PORT}`);
  log(`  POST /webhooks/razorpay   POST+GET /webhooks/whatsapp`);
  log(`  GET  /api/state  POST /api/invoices  POST /api/tick  GET /api/audit`);
});
