import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { geminiToTwilio, twilioToGemini } from "./lib/audio.js";
import { AudioPacer, InboundBatcher } from "./lib/pacer.js";
import { systemInstruction, VOICE_TOOLS, type VoiceContext } from "./lib/prompt.js";

/**
 * Twilio Media Streams to Gemini Live, running beside Twilio's media servers.
 *
 * Only the audio path lives here. The ledger stays with the merchant and is
 * reached over HTTP when a tool fires, a handful of times per call, never per
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
  const state = (await res.json()) as { invoices: any[]; demoOffsetMs?: number };
  const row = state.invoices.find((i) => i.invoice.id === invoiceId);
  if (!row) throw new Error(`unknown invoice ${invoiceId}`);
  return {
    invoiceId,
    buyerName: row.buyer.name,
    buyerPhone: row.buyer.phone,
    outstanding: row.outstanding,
    dueOn: row.invoice.dueOn,
    daysOverdue: row.daysOverdue,
    // The ledger's clock, not the wall clock. In a demo the calendar is moved
    // forward, and "parso" resolved against the real date produced a promise
    // for a day the ledger had already lived past: recorded, instantly stale.
    today: new Date(Date.now() + (state.demoOffsetMs ?? 0) + 5.5 * 3600_000).toISOString().slice(0, 10),
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
    <Stream url="wss://${host}/media">
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
      framesOut += 1;
      if (framesOut % 250 === 0) log(`  outbound ${framesOut} frames, ${pacer.queuedMs}ms queued`);
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    } else if (!streamSid) {
      log("  DROPPED outbound frame: no streamSid");
    }
  });
  let framesIn = 0, bytesToGemini = 0, framesOut = 0, geminiChunks = 0;
  /** Set when a tool concluded the call: hang up once she finishes speaking. */
  let endAfterTurn = false;
  /**
   * A terminal tool has run. She says goodbye in the same turn as the tool
   * call, but the tool result is still owed back to the model, and answering it
   * makes the model take another turn: a second, identical goodbye. So the turn
   * carrying the tool is allowed to finish and every generation after it is
   * dropped on the floor.
   */
  let concluded = false;
  let goodbyeDone = false;

  /** Hang up once the audio already queued has actually played out. */
  const hangUpWhenDrained = (why: string): void => {
    const tick = (): void => {
      if (pacer.queuedMs <= 40) shutdown(why);
      else setTimeout(tick, 120);
    };
    tick();
  };
  // Rolling loudness of what we hand the model. Silence and speech look
  // identical in a byte count, and every diagnosis so far has been guesswork
  // about which one is arriving.
  let rmsSum = 0, rmsN = 0, rmsPeak = 0;
  const measure = (pcm: Buffer): void => {
    let sum = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, pcm.length / 2));
    rmsSum += rms; rmsN += 1;
    if (rms > rmsPeak) rmsPeak = rms;
  };

  const batcher = new InboundBatcher((pcm) => {
    bytesToGemini += pcm.length;
    measure(pcm);
    sendAudio(pcm);
  }, 60);

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
          // Pinned, and deliberately not an alias. On
          // gemini-2.5-flash-native-audio-latest the session would accept audio
          // and never emit a transcript or a turn: the greeting played, the
          // buyer spoke, and nothing came back. Same code, same audio, one call
          // working and the next silent, because the alias resolved to
          // different backends. This model holds a multi-turn conversation,
          // fires tools and closes cleanly.
          model: `models/${process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview"}`,
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
        // Dropped, not flushed. This is whatever Twilio sent between the media
        // stream opening and the model finishing setup: dial noise from before
        // anyone had spoken, since she has not even given the opening line yet.
        // Pushing it in as realtime input and then immediately forcing the
        // opening turn left the session with a stream it never resolved, and
        // the buyer's speech was never detected for the rest of the call. Every
        // silent call had pre-roll; the ones that worked had none.
        if (queued.length > 0) log(`  dropped ${queued.length} pre-roll frames from before setup`);
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
          // Anything generated after the goodbye turn is the model answering
          // its own tool result. Nobody needs to hear the goodbye twice.
          if (part.inlineData?.data && !goodbyeDone) {
            pacer.push(Buffer.from(geminiToTwilio(Buffer.from(part.inlineData.data, "base64")), "base64"));
          }
        }
        if (sc.outputTranscription?.text) process.stdout.write(sc.outputTranscription.text);
        if (sc.inputTranscription?.text) log(`  buyer: ${sc.inputTranscription.text}`);
        if (sc.turnComplete) log("  model turn complete");
        if (sc.generationComplete) log("  generation complete");
        if ((sc.turnComplete || sc.generationComplete) && (concluded || endAfterTurn) && !goodbyeDone) {
          goodbyeDone = true;
          log("  business concluded and she has finished speaking");
          hangUpWhenDrained("goodbye said");
        }
      }

      if (msg.toolCall?.functionCalls) {
        const responses: Record<string, unknown>[] = [];
        for (const call of msg.toolCall.functionCalls as { id?: string; name: string; args?: Record<string, unknown> }[]) {
          const outcome = await runTool(call.name, call.args ?? {}, ctx, callSid);
          log(`  tool ${call.name} -> ${outcome.detail}`);
          responses.push({ id: call.id, name: call.name, response: { result: outcome.detail } });
          // Not a fixed timer. Six seconds is either a cut-off or dead air
          // depending on how long the goodbye ran. Wait for the turn to end and
          // the queued audio to drain instead.
          if (outcome.endCall) {
            concluded = true;
            setTimeout(() => {
              if (!goodbyeDone) { goodbyeDone = true; hangUpWhenDrained("business concluded"); }
            }, 12_000);
          }
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
      case "media": {
        framesIn += 1;
        const pcm = twilioToGemini(msg.media.payload);
        if (framesIn === 1) log(`  first inbound frame: ${msg.media.payload.length}b mulaw -> ${pcm.length}b pcm16`);
        if (framesIn % 250 === 0) {
          const avg = rmsN ? rmsSum / rmsN : 0;
          log(`  inbound ${framesIn} frames, ${bytesToGemini}b to gemini, ready=${ready}, rms avg ${avg.toFixed(4)} peak ${rmsPeak.toFixed(4)}`);
          rmsSum = 0; rmsN = 0; rmsPeak = 0;
        }
        batcher.push(pcm);
        break;
      }
      case "stop":
        shutdown("twilio hung up");
        break;
    }
  });

  ws.on("close", () => shutdown("socket closed"));
});

const PORT = Number(process.env.PORT ?? 8080);
server.listen(PORT, () => {
  log(`baaki voice bridge on :${PORT}`);
  log(`  GET /twiml?invoice=inv_1   (Twilio fetches this)`);
  log(`  WS  /media                 (Twilio Media Streams)`);
});
