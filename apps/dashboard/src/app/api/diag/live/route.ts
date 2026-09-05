import WebSocket from "ws";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Can this runtime open an outbound WebSocket to Gemini Live, and does the
 * session reach setupComplete? Everything downstream depends on it, and a
 * silent phone call looks identical whether the socket failed to open or the
 * model simply had nothing to say.
 */
export async function GET() {
  const url =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
    process.env.GEMINI_API_KEY;

  const steps: string[] = [];
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let ws: WebSocket;
    try {
      // permessage-deflate is a common cause of a socket that opens and then
      // never delivers a frame; Gemini does not need it.
      ws = new WebSocket(url, { perMessageDeflate: false, skipUTF8Validation: true });
    } catch (e) {
      return resolve({ ok: false, stage: "construct", error: String(e) });
    }
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* gone */ }
      resolve({ ok: false, stage: "timeout", steps });
    }, 25_000);

    ws.on("open", () => {
      steps.push("open");
      ws.send(JSON.stringify({
        setup: {
          model: "models/" + (process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest"),
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE ?? "Aoede" } } },
          },
        },
      }));
    });
    ws.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      steps.push("message:" + text.slice(0, 60));
      clearTimeout(t);
      try { ws.close(); } catch { /* gone */ }
      resolve({ ok: text.includes("setupComplete"), steps });
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, stage: "error", error: e.message, steps });
    });
    ws.on("close", (code, reason) => {
      steps.push(`close:${code}:${reason?.toString().slice(0, 60) ?? ""}`);
    });
  });

  return json(result);
}
