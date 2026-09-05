import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_POLICY, LedgerStore, formatINR, istParts, type Policy,
} from "@baaki/core";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { LiveSession } from "./live.js";
import { handleTurn, openingLine, sayAndListen, sayAndHangUp } from "@baaki/core";
import { geminiToTwilio, twilioToGemini } from "./audio.js";
import { AudioPacer, InboundBatcher } from "./pacer.js";
import type { VoiceContext } from "@baaki/core";

const PORT = Number(process.env.VOICE_PORT ?? 3002);
const store = new LedgerStore("data/ledger.json");

const loadPolicy = (): Policy =>
  existsSync("data/policy.json")
    ? { ...DEFAULT_POLICY, ...JSON.parse(readFileSync("data/policy.json", "utf8")) }
    : DEFAULT_POLICY;

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function remoteContext(invoiceId: string): Promise<VoiceContext> {
  const res = await fetch(`${process.env.BAAKI_API}/api/state`);
  const state = (await res.json()) as { invoices: any[] };
  const row = state.invoices.find((i) => i.invoice.id === invoiceId);
  if (!row) throw new Error(`unknown invoice ${invoiceId}`);
  return {
    invoiceId,
    buyerName: row.buyer.name,
    buyerPhone: row.buyer.phone,
    outstanding: row.outstanding,
    dueOn: row.invoice.dueOn,
    daysOverdue: row.daysOverdue,
    today: new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10),
    shortUrl: row.external?.shortUrl,
  };
}

function contextFor(invoiceId: string): VoiceContext {
  const policy = loadPolicy();
  const ledger = store.load(policy);
  const c = ledger.caseFile(invoiceId, Date.now());
  return {
    invoiceId,
    buyerName: c.buyer.name,
    buyerPhone: c.buyer.phone,
    outstanding: c.invoice.amount - c.invoice.amountPaid,
    dueOn: c.invoice.dueOn,
    daysOverdue: c.daysOverdue,
    today: c.today,
    shortUrl: ledger.external(invoiceId)?.shortUrl,
  };
}

/** Call transcripts are audit evidence, so they are written where the case can find them. */
function saveTranscript(invoiceId: string, callSid: string, lines: { who: string; text: string; ts: number }[]): void {
  mkdirSync("data/calls", { recursive: true });
  writeFileSync(`data/calls/${invoiceId}_${callSid}.json`, JSON.stringify({ invoiceId, callSid, lines }, null, 2));
}

function formBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const xml = (body: string) => { res.writeHead(200, { "Content-Type": "text/xml" }); res.end(body); };
  const publicBase = process.env.PUBLIC_VOICE_URL ?? `http://localhost:${PORT}`;

  // -- turn-based path: plain HTTPS, no WebSocket ---------------------------
  if (url.pathname === "/voice/answer") {
    const invoiceId = url.searchParams.get("invoice") ?? "";
    try {
      const ctx = contextFor(invoiceId);
      log(`gather call answered invoice=${invoiceId} buyer=${ctx.buyerName}`);
      return xml(sayAndListen(openingLine(ctx), `${publicBase}/voice/turn?invoice=${encodeURIComponent(invoiceId)}`));
    } catch {
      return xml(sayAndHangUp("Sorry, is invoice ki jaankari nahi mili."));
    }
  }

  if (url.pathname === "/voice/turn" && req.method === "POST") {
    const invoiceId = url.searchParams.get("invoice") ?? "";
    const form = await formBody(req);
    const speech = form.SpeechResult ?? "";
    const callSid = form.CallSid ?? "twilio";
    log(`  buyer said: "${speech}" (confidence ${form.Confidence ?? "?"})`);
    try {
      const ctx = contextFor(invoiceId);
      const action = `${publicBase}/voice/turn?invoice=${encodeURIComponent(invoiceId)}`;
      const r = await handleTurn(speech, Number(form.Confidence ?? 0), ctx, store, loadPolicy(), callSid, action);
      if (r.toolFired) log(`  tool ${r.toolFired} -> ${r.outcome ?? ""}`);
      saveTranscript(invoiceId, callSid, [
        { who: "buyer", text: speech, ts: Date.now() },
        ...(r.toolFired ? [{ who: "tool", text: `${r.toolFired}: ${r.outcome ?? ""}`, ts: Date.now() }] : []),
      ]);
      return xml(r.xml);
    } catch (e) {
      log("  turn error", e instanceof Error ? e.message : e);
      return xml(sayAndHangUp("Maaf kijiye, ek dikkat aa gayi. Dhanyavaad."));
    }
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ ok: true, gemini: Boolean(process.env.GEMINI_API_KEY) }));
  }

  // Twilio fetches this when a call connects, inbound or outbound.
  if (url.pathname === "/twiml") {
    const invoiceId = url.searchParams.get("invoice") ?? "";
    const base = (process.env.PUBLIC_VOICE_URL ?? `ws://localhost:${PORT}`).replace(/^http/, "ws");
    // The invoice travels as a <Parameter>, not a query string. Twilio opens
    // the media socket against the path alone. ngrok logged
    // `GET /media -> 101` with the query gone, so anything encoded in the URL
    // is lost and the socket arrives with no idea which case it is for.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${base}/media">
      <Parameter name="invoice" value="${invoiceId}" />
    </Stream>
  </Connect>
</Response>`;
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(xml);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/media" && url.pathname !== "/browser") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const isTwilio = url.pathname === "/media";

  const transcript: { who: string; text: string; ts: number }[] = [];
  let streamSid: string | null = null;
  let callSid = isTwilio ? "pending" : `browser_${Date.now().toString(36)}`;
  let session: LiveSession | null = null;
  let invoiceId = url.searchParams.get("invoice") ?? "";

  // Twilio wants a steady 20 ms frame; Gemini emits whole phrases at once.
  const pacer = isTwilio
    ? new AudioPacer((payload) => {
        if (ws.readyState === ws.OPEN && streamSid) {
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        }
      })
    : null;
  const batcher = new InboundBatcher((pcm) => session?.sendAudio(pcm), 60);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { ws.send(JSON.stringify({ type: "error", message: "GEMINI_API_KEY not set" })); ws.close(); return; }

  /** Built once the invoice is known: from the query for a browser, from the start event for Twilio. */
  async function begin(id: string): Promise<void> {
    if (session) return;
    let ctx: VoiceContext;
    try {
      ctx = process.env.BAAKI_API ? await remoteContext(id) : contextFor(id);
    } catch {
      log(`  unknown invoice "${id}", closing`);
      if (!isTwilio) ws.send(JSON.stringify({ type: "error", message: `unknown invoice ${id}` }));
      ws.close();
      return;
    }

    log(`call open (${isTwilio ? "twilio" : "browser"}) invoice=${id} buyer=${ctx.buyerName} outstanding=${formatINR(ctx.outstanding)}`);

    session = new LiveSession({
      apiKey: apiKey!,
      ctx,
      store,
      policy: loadPolicy(),
      callSid,
      ...(process.env.BAAKI_API ? { apiBase: process.env.BAAKI_API } : {}),
      onAudio: (pcm24) => {
        if (ws.readyState !== ws.OPEN) return;
        if (isTwilio) {
          // Transcode to mu-law and hand to the pacer, which releases it at
          // real-time rate. Sending a whole phrase as one media message got it
          // truncated, which is why she stopped mid-sentence.
          pacer?.push(Buffer.from(geminiToTwilio(pcm24), "base64"));
        } else {
          ws.send(pcm24, { binary: true });
        }
      },
      onInterrupted: () => {
        // Abandoned turn: drop what is queued rather than play it over her.
        pacer?.clear();
        if (!isTwilio && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "interrupted" }));
      },
      onTranscript: (who, text) => {
        transcript.push({ who, text, ts: Date.now() });
        if (ws.readyState === ws.OPEN && !isTwilio) ws.send(JSON.stringify({ type: "transcript", who, text }));
      },
      onToolCall: (name, args, outcome) => {
        log(`  tool ${name}`, JSON.stringify(args), "->", outcome);
        transcript.push({ who: "tool", text: `${name}: ${outcome}`, ts: Date.now() });
        if (ws.readyState === ws.OPEN && !isTwilio) ws.send(JSON.stringify({ type: "tool", name, args, outcome }));
      },
      onClose: (reason) => {
        log(`  live session closed: ${reason}`);
        if (transcript.length) saveTranscript(id, callSid, transcript);
        batcher.stop();
        // Let the pacer drain what is already queued before dropping the
        // socket, so the closing sentence is not cut off by the hangup.
        const drain = pacer ? pacer.queuedMs + 400 : 0;
        setTimeout(() => { pacer?.stop(); if (ws.readyState === ws.OPEN) ws.close(); }, drain);
      },
    });

    try {
      await session.open();
      if (!isTwilio) ws.send(JSON.stringify({ type: "ready", buyer: ctx.buyerName, outstanding: ctx.outstanding }));
      log("  live session ready");
      session.greet();
    } catch (e) {
      log("  live open failed", e instanceof Error ? e.message : e);
      if (!isTwilio) ws.send(JSON.stringify({ type: "error", message: String(e) }));
      ws.close();
    }
  }

  ws.on("message", (data, isBinary) => {
    if (isTwilio) {
      let msg: Record<string, any>;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.event) {
        case "start": {
          streamSid = msg.start?.streamSid ?? null;
          callSid = msg.start?.callSid ?? callSid;
          const param = msg.start?.customParameters?.invoice;
          if (param) invoiceId = String(param);
          log(`  twilio stream start sid=${streamSid} invoice=${invoiceId || "(none)"}`);
          void begin(invoiceId);
          break;
        }
        case "media":
          batcher.push(twilioToGemini(msg.media.payload));
          break;
        case "stop":
          log("  twilio stream stop");
          batcher.stop(); pacer?.stop();
          session?.close("twilio hung up");
          break;
      }
      return;
    }
    if (isBinary) { session?.sendAudio(data as Buffer); return; }
    try {
      const m = JSON.parse(data.toString()) as { type?: string; text?: string };
      if (m.type === "text" && m.text) {
        transcript.push({ who: "buyer", text: m.text, ts: Date.now() });
        session?.sendText(m.text);
      }
    } catch { /* not JSON: ignore */ }
  });

  ws.on("close", () => {
    log(`call closed invoice=${invoiceId}`);
    batcher.stop(); pacer?.stop();
    session?.close("socket closed");
    if (transcript.length) saveTranscript(invoiceId, callSid, transcript);
  });

  // A browser knows its invoice from the query and can start immediately.
  if (!isTwilio && invoiceId) await begin(invoiceId);
});

server.listen(PORT, () => {
  log(`baaki voice service on :${PORT}`);
  log(`  GET  /twiml?invoice=inv_1   (Twilio fetches this)`);
  log(`  WS   /media?invoice=inv_1   (Twilio Media Streams, mu-law 8k)`);
  log(`  WS   /browser?invoice=inv_1 (browser mic, PCM 16k)`);
});
