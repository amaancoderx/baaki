import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_POLICY, LedgerStore, formatINR, istParts, type Policy,
} from "@baaki/core";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { LiveSession } from "./live.js";
import { handleTurn, openingLine, sayAndListen, sayAndHangUp } from "./gather.js";
import { geminiToTwilio, twilioToGemini } from "./audio.js";
import type { VoiceContext } from "./tools.js";

const PORT = Number(process.env.VOICE_PORT ?? 3002);
const store = new LedgerStore("data/ledger.json");

const loadPolicy = (): Policy =>
  existsSync("data/policy.json")
    ? { ...DEFAULT_POLICY, ...JSON.parse(readFileSync("data/policy.json", "utf8")) }
    : DEFAULT_POLICY;

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${base}/media?invoice=${encodeURIComponent(invoiceId)}" />
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
  const invoiceId = url.searchParams.get("invoice") ?? "";

  let ctx: VoiceContext;
  try {
    ctx = contextFor(invoiceId);
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: `unknown invoice ${invoiceId}` }));
    ws.close();
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { ws.send(JSON.stringify({ type: "error", message: "GEMINI_API_KEY not set" })); ws.close(); return; }

  const transcript: { who: string; text: string; ts: number }[] = [];
  let streamSid: string | null = null;
  let callSid = isTwilio ? "pending" : `browser_${Date.now().toString(36)}`;

  log(`call open (${isTwilio ? "twilio" : "browser"}) invoice=${invoiceId} buyer=${ctx.buyerName} outstanding=${formatINR(ctx.outstanding)}`);

  const session = new LiveSession({
    apiKey,
    ctx,
    store,
    policy: loadPolicy(),
    callSid,
    onAudio: (pcm24) => {
      if (ws.readyState !== ws.OPEN) return;
      if (isTwilio && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: geminiToTwilio(pcm24) } }));
      } else if (!isTwilio) {
        ws.send(pcm24, { binary: true });
      }
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
      if (transcript.length) saveTranscript(invoiceId, callSid, transcript);
      if (ws.readyState === ws.OPEN) ws.close();
    },
  });

  // Attached before the Live session is opened. Twilio sends `connected` and
  // `start` the moment the socket is up, and opening a Gemini session takes
  // about a second; a listener attached after that await misses both, so
  // streamSid is never learned and every byte of the agent's reply is dropped
  // into a call that sounds like silence. LiveSession queues audio that
  // arrives before it is ready, so nothing is lost by listening early.
  ws.on("message", (data, isBinary) => {
    if (isTwilio) {
      const msg = JSON.parse(data.toString()) as Record<string, any>;
      switch (msg.event) {
        case "start":
          streamSid = msg.start?.streamSid ?? null;
          callSid = msg.start?.callSid ?? callSid;
          log(`  twilio stream start sid=${streamSid}`);
          break;
        case "media":
          session.sendAudio(twilioToGemini(msg.media.payload));
          break;
        case "stop":
          log("  twilio stream stop");
          session.close("twilio hung up");
          break;
      }
      return;
    }
    // Browser sends raw 16 kHz PCM frames, or a typed turn as a fallback.
    if (isBinary) { session.sendAudio(data as Buffer); return; }
    try {
      const m = JSON.parse(data.toString()) as { type?: string; text?: string };
      if (m.type === "text" && m.text) {
        transcript.push({ who: "buyer", text: m.text, ts: Date.now() });
        session.sendText(m.text);
      }
    } catch { /* not JSON: ignore */ }
  });


  try {
    await session.open();
    if (!isTwilio) ws.send(JSON.stringify({ type: "ready", buyer: ctx.buyerName, outstanding: ctx.outstanding }));
    log("  live session ready");
    // Outbound call: the agent speaks first, starting with the consent line.
    session.greet();
  } catch (e) {
    log("  live open failed", e instanceof Error ? e.message : e);
    ws.send(JSON.stringify({ type: "error", message: String(e) }));
    ws.close();
    return;
  }

  ws.on("close", () => {
    log(`call closed invoice=${invoiceId}`);
    session.close("socket closed");
    if (transcript.length) saveTranscript(invoiceId, callSid, transcript);
  });
});

server.listen(PORT, () => {
  log(`baaki voice service on :${PORT}`);
  log(`  GET  /twiml?invoice=inv_1   (Twilio fetches this)`);
  log(`  WS   /media?invoice=inv_1   (Twilio Media Streams, mu-law 8k)`);
  log(`  WS   /browser?invoice=inv_1 (browser mic, PCM 16k)`);
});
