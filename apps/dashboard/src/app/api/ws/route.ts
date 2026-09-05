import { experimental_upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";
import {
  geminiToTwilio, twilioToGemini, AudioPacer, InboundBatcher,
  runVoiceTool, systemInstruction, VOICE_TOOLS, type VoiceContext,
} from "@baaki/core";
import { policy, store } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Twilio Media Streams to Gemini Live, in the same region as Twilio's media.
 *
 * This is the path worth having. The turn-based fallback puts Twilio's
 * text-to-speech and Twilio's recogniser in the loop, and both are noticeably
 * worse: the voice sounds synthetic and Hindi comes back mangled. Here the
 * model hears the caller directly and answers in its own voice, so neither
 * conversion happens at all.
 */
/**
 * Twilio frames can arrive as a string, a Buffer, an ArrayBuffer or a typed
 * array depending on the runtime. `String(arrayBuffer)` yields
 * "[object ArrayBuffer]", so a naive decode throws inside JSON.parse and a
 * swallowing catch turns every inbound frame into silence.
 */
function decode(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data as ArrayBufferView)) {
    const v = data as ArrayBufferView;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
  }
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data && typeof (data as { toString?: unknown }).toString === "function") {
    return String(data);
  }
  return "";
}

export function GET(req: Request) {
  const invoiceFromQuery = new URL(req.url).searchParams.get("invoice") ?? "";

  return experimental_upgradeWebSocket((client) => {
    let streamSid: string | null = null;
    let callSid = "pending";
    let live: WebSocket | null = null;
    let ready = false;
    let closed = false;
    let invoiceId = invoiceFromQuery;
    const queued: Buffer[] = [];

    const pacer = new AudioPacer((payload) => {
      if (streamSid) client.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
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
      console.log("voice: closing -", why);
      batcher.stop();
      const drain = pacer.queuedMs + 400;
      setTimeout(() => {
        pacer.stop();
        try { live?.close(); } catch { /* gone */ }
        try { client.close(); } catch { /* gone */ }
      }, drain);
    }

    async function begin(id: string): Promise<void> {
      const p = await policy();
      const s = store();
      const ledger = await s.load(p);

      let ctx: VoiceContext;
      try {
        const c = ledger.caseFile(id, Date.now());
        ctx = {
          invoiceId: id,
          buyerName: c.buyer.name,
          buyerPhone: c.buyer.phone,
          outstanding: c.invoice.amount - c.invoice.amountPaid,
          dueOn: c.invoice.dueOn,
          daysOverdue: c.daysOverdue,
          today: c.today,
          shortUrl: ledger.external(id)?.shortUrl,
        };
      } catch {
        return shutdown("unknown invoice " + id);
      }
      console.log("voice: call for " + id + " - " + ctx.buyerName);

      live = new WebSocket(LIVE_URL + "?key=" + process.env.GEMINI_API_KEY);

      live.on("open", () => {
        console.log("voice: gemini socket open");
        live!.send(JSON.stringify({
          setup: {
            model: "models/" + (process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest"),
            generationConfig: {
              responseModalities: ["AUDIO"],
              // No languageCode: native-audio models reject it and close 1007.
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE ?? "Aoede" } },
              },
              temperature: 0.6,
            },
            systemInstruction: { parts: [{ text: systemInstruction(ctx) }] },
            tools: [{ functionDeclarations: VOICE_TOOLS }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
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

      live.on("message", async (raw: unknown) => {
        let msg: Record<string, any>;
        try { msg = JSON.parse(decode(raw)) as Record<string, any>; }
        catch { return; }

        if (msg.setupComplete) {
          ready = true;
          for (const q of queued) sendAudio(q);
          queued.length = 0;
          live!.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "[The call has connected. Deliver your opening line now, exactly as instructed.]" }] }],
              turnComplete: true,
            },
          }));
          console.log("voice: live ready");
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
          if (sc.inputTranscription?.text) console.log("voice: buyer - " + sc.inputTranscription.text);
        }

        if (msg.toolCall?.functionCalls) {
          const responses: Record<string, unknown>[] = [];
          for (const call of msg.toolCall.functionCalls as { id?: string; name: string; args?: Record<string, unknown> }[]) {
            let outcome: { ok: boolean; detail: string; endCall?: boolean };
            try {
              outcome = await runVoiceTool(call.name, call.args ?? {}, ctx, s, p, callSid);
            } catch (e) {
              outcome = { ok: false, detail: e instanceof Error ? e.message : String(e) };
            }
            console.log("voice: tool " + call.name + " -> " + outcome.detail);
            responses.push({ id: call.id, name: call.name, response: { result: outcome.detail } });
            if (outcome.endCall) setTimeout(() => shutdown("business concluded"), 6_000);
          }
          live!.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        }
      });

      live.on("close", (code: number) => shutdown("live closed " + code));
      live.on("error", (e: Error) => shutdown("live error " + e.message));
    }

    client.on("message", (data: unknown) => {
      let msg: Record<string, any>;
      const text = decode(data);
      try {
        msg = JSON.parse(text);
      } catch {
        console.log("voice: undecodable frame", typeof data, text.slice(0, 60));
        return;
      }
      if (msg.event !== "media") console.log("voice: twilio event", msg.event);
      switch (msg.event) {
        case "start":
          streamSid = msg.start?.streamSid ?? null;
          callSid = msg.start?.callSid ?? callSid;
          // Twilio drops the query string from the stream URL, so the invoice
          // arrives as a <Parameter> on this event.
          invoiceId = String(msg.start?.customParameters?.invoice ?? invoiceId);
          void begin(invoiceId);
          break;
        case "media":
          batcher.push(twilioToGemini(msg.media.payload));
          break;
        case "stop":
          shutdown("twilio hung up");
          break;
      }
    });

    client.on("close", () => shutdown("socket closed"));
  });
}
