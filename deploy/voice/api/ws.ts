import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { geminiToTwilio, twilioToGemini } from "../lib/audio.js";
import { AudioPacer, InboundBatcher } from "../lib/pacer.js";
import { systemInstruction, VOICE_TOOLS, type VoiceContext } from "../lib/prompt.js";

/**
 * Twilio Media Streams to Gemini Live, running beside Twilio's media servers.
 *
 * Only the audio path lives here. The ledger stays with the merchant and is
 * reached over HTTP when a tool fires — a handful of times per call, never per
 * frame. That split is the whole point: audio round trips are what a caller
 * hears, and they must not cross an ocean.
 */

const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const API = process.env.BAAKI_API ?? "";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function contextFor(invoiceId: string): Promise<VoiceContext> {
  const res = await fetch(`${API}/api/state`, { headers: { "cache-control": "no-store" } });
  if (!res.ok) throw new Error(`ledger returned ${res.status}`);
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

async function runTool(
  name: string, args: Record<string, unknown>, ctx: VoiceContext, callSid: string,
): Promise<{ ok: boolean; detail: string; endCall?: boolean }> {
  try {
    const res = await fetch(`${API}/api/voice/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId: ctx.invoiceId, name, args, callSid }),
    });
    if (!res.ok) return { ok: false, detail: `ledger returned ${res.status}` };
    return (await res.json()) as { ok: boolean; detail: string; endCall?: boolean };
  } catch (e) {
    // Never tell a buyer something was recorded when the write failed.
    return { ok: false, detail: `could not reach the ledger: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.endsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, api: Boolean(API), gemini: Boolean(process.env.GEMINI_API_KEY) }));
  }

  // Twilio fetches this when the call connects. The invoice travels as a
  // <Parameter>: Twilio drops the query string from the stream URL.
  if (url.pathname.endsWith("/twiml")) {
    const invoice = url.searchParams.get("invoice") ?? "";
    const host = req.headers.host ?? "";
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/api/ws">
      <Parameter name="invoice" value="${invoice}" />
    </Stream>
  </Connect>
</Response>`);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  let streamSid: string | null = null;
  let callSid = "pending";
  let live: WebSocket | null = null;
  let ready = false;
  let closed = false;
  const queued: Buffer[] = [];

  const pacer = new AudioPacer((payload) => {
    if (ws.readyState === ws.OPEN && streamSid) {
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    }
  });
  const batcher = new InboundBatcher((pcm) => sendAudio(pcm), 60);

  function sendAudio(pcm16: Buffer): void {
    if (closed) return;
    if (!ready) { queued.push(pcm16); return; }
    live?.send(JSON.stringify({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm16.toString("base64") } },
    }));
  }

  function shutdown(why: string): void {
    if (closed) return;
    closed = true;
    log("  closing:", why);
    batcher.stop();
    const drain = pacer.queuedMs + 400;
    setTimeout(() => {
      pacer.stop();
      try { live?.close(); } catch { /* gone */ }
      if (ws.readyState === ws.OPEN) ws.close();
    }, drain);
  }

  async function begin(invoiceId: string): Promise<void> {
    let ctx: VoiceContext;
    try {
      ctx = await contextFor(invoiceId);
    } catch (e) {
      log("  cannot load case:", e instanceof Error ? e.message : e);
      return shutdown("unknown invoice");
    }
    log(`call invoice=${invoiceId} buyer=${ctx.buyerName} outstanding=${ctx.outstanding}`);

    live = new WebSocket(`${LIVE_URL}?key=${process.env.GEMINI_API_KEY}`);

    live.on("open", () => {
      live!.send(JSON.stringify({
        setup: {
          model: `models/${process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest"}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            // No languageCode: native-audio models reject it and close with 1007.
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE ?? "Aoede" } },
            },
            temperature: 0.6,
          },
          systemInstruction: { parts: [{ text: systemInstruction(ctx) }] },
          tools: [{ functionDeclarations: VOICE_TOOLS }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Tuned for a phone line: HIGH start-sensitivity read line noise as
          // speech and the model kept restarting its turn.
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
              prefixPaddingMs: 200,
              silenceDurationMs: 350,
            },
          },
        },
      }));
    });

    live.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, any>;

      if (msg.setupComplete) {
        ready = true;
        for (const q of queued) sendAudio(q);
        queued.length = 0;
        // Outbound call: she speaks first, starting with the consent line.
        live!.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: "[The call has connected. Deliver your opening line now, exactly as instructed.]" }] }],
            turnComplete: true,
          },
        }));
        log("  live ready");
        return;
      }

      const sc = msg.serverContent;
      if (sc?.interrupted) pacer.clear();
      if (sc) {
        for (const part of sc.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) {
            pacer.push(Buffer.from(geminiToTwilio(Buffer.from(part.inlineData.data, "base64")), "base64"));
          }
        }
        if (sc.outputTranscription?.text) process.stdout.write(sc.outputTranscription.text);
        if (sc.inputTranscription?.text) log(`  buyer: ${sc.inputTranscription.text}`);
      }

      if (msg.toolCall?.functionCalls) {
        const responses: Record<string, unknown>[] = [];
        for (const call of msg.toolCall.functionCalls as { id?: string; name: string; args?: Record<string, unknown> }[]) {
          const outcome = await runTool(call.name, call.args ?? {}, ctx, callSid);
          log(`  tool ${call.name} -> ${outcome.detail}`);
          responses.push({ id: call.id, name: call.name, response: { result: outcome.detail } });
          if (outcome.endCall) setTimeout(() => shutdown("business concluded"), 6_000);
        }
        live!.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      }
    });

    live.on("close", (code, reason) => shutdown(`live closed ${code} ${reason?.toString().slice(0, 80) ?? ""}`));
    live.on("error", (e) => shutdown(`live error ${e.message}`));
  }

  ws.on("message", (data) => {
    let msg: Record<string, any>;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid ?? null;
        callSid = msg.start?.callSid ?? callSid;
        void begin(String(msg.start?.customParameters?.invoice ?? ""));
        break;
      case "media":
        batcher.push(twilioToGemini(msg.media.payload));
        break;
      case "stop":
        shutdown("twilio hung up");
        break;
    }
  });

  ws.on("close", () => shutdown("socket closed"));
});

export default server;
