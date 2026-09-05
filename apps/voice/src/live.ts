import WebSocket from "ws";
import type { LedgerStore, Policy } from "@baaki/core";
import { runVoiceTool, runVoiceToolRemote, systemInstruction, VOICE_TOOLS, type VoiceContext } from "@baaki/core";

/**
 * One Gemini Live session per call. Audio in, audio out, tool calls in the
 * middle. The session owns nothing durable: every tool call goes through the
 * same ledger and audit path as WhatsApp, so a promise made on a call is the
 * same object as a promise made in a chat.
 */

const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface LiveSessionOptions {
  apiKey: string;
  model?: string;
  ctx: VoiceContext;
  store: LedgerStore;
  policy: Policy;
  callSid?: string;
  /** Set when the ledger lives elsewhere; tool effects go over HTTP. */
  apiBase?: string;
  /** 24 kHz PCM chunks from the model. */
  onAudio: (pcm24: Buffer) => void;
  onTranscript: (who: "buyer" | "agent", text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, outcome: string) => void;
  /** The model's turn was cut short; drop any audio still queued for playback. */
  onInterrupted?: () => void;
  onClose: (reason: string) => void;
}

export class LiveSession {
  #ws: WebSocket | null = null;
  #ready = false;
  #queue: Buffer[] = [];
  #closed = false;

  constructor(private readonly o: LiveSessionOptions) {}

  get ready(): boolean { return this.#ready; }

  async open(): Promise<void> {
    const model = this.o.model ?? process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest";
    const ws = new WebSocket(`${LIVE_URL}?key=${this.o.apiKey}`);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Live API did not open in 15s")), 15_000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              // A named prebuilt voice, not the default. Aoede and Leda are the
              // warmer female voices; the default reads like an announcement.
              // No languageCode here. Native-audio models choose the language
              // themselves and reject the field: setting it closed the socket
              // with 1007 "audio content type not supported for this model
              // configuration" the moment real audio arrived. Language is
              // steered from the system instruction instead.
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE ?? "Aoede" },
                },
              },
              temperature: 0.6,
            },
            systemInstruction: { parts: [{ text: systemInstruction(this.o.ctx) }] },
            tools: [{ functionDeclarations: VOICE_TOOLS }],
            // Both sides transcribed so the audit trail has words, not just audio.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // Let the buyer interrupt. On a collections call people talk over
            // you, and a model that finishes its sentence regardless is the
            // single clearest tell that they are talking to a machine.
            // Tuned for a phone line, not a headset. HIGH start-sensitivity
            // treated line noise as the buyer speaking, so the model kept
            // abandoning and restarting its turn — heard as repeated
            // sentences. LOW start with a normal end and a shorter silence
            // window is both calmer and quicker to answer.
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
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.setupComplete) {
          clearTimeout(timer);
          this.#ready = true;
          for (const q of this.#queue) this.#sendAudio(q);
          this.#queue = [];
          resolve();
          return;
        }
        void this.#handle(msg);
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
      ws.on("close", (code, reason) => {
        this.#closed = true;
        this.o.onClose(`live closed ${code} ${reason?.toString().slice(0, 120) ?? ""}`);
      });
    });
  }

  async #handle(msg: Record<string, any>): Promise<void> {
    const sc = msg.serverContent;
    if (sc?.interrupted) {
      // The buyer talked over her. Everything already queued belongs to a turn
      // that is now abandoned; playing it out is what makes an agent sound like
      // it is repeating itself.
      this.o.onInterrupted?.();
    }
    if (sc) {
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.o.onAudio(Buffer.from(part.inlineData.data, "base64"));
      }
      if (sc.inputTranscription?.text) this.o.onTranscript("buyer", sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.o.onTranscript("agent", sc.outputTranscription.text);
    }

    if (msg.toolCall?.functionCalls) {
      const responses: Record<string, unknown>[] = [];
      for (const call of msg.toolCall.functionCalls as { id?: string; name: string; args?: Record<string, unknown> }[]) {
        let outcome: { ok: boolean; detail: string; endCall?: boolean };
        try {
          outcome = this.o.apiBase
            ? await runVoiceToolRemote(this.o.apiBase, call.name, call.args ?? {}, this.o.ctx, this.o.callSid ?? "call")
            : await runVoiceTool(call.name, call.args ?? {}, this.o.ctx, this.o.store, this.o.policy, this.o.callSid);
        } catch (e) {
          outcome = { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
        this.o.onToolCall(call.name, call.args ?? {}, outcome.detail);
        responses.push({ id: call.id, name: call.name, response: { result: outcome.detail } });
        if (outcome.endCall) {
          // Long enough for the one-line confirmation to finish playing, short
          // enough that the buyer is not left holding a dead line. Without
          // this the agent said goodbye and the call simply stayed open.
          setTimeout(() => this.close("business concluded"), 6_000);
        }
      }
      this.#ws?.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }
  }

  /**
   * Opens the call. Native-audio models wait for speech before responding, so
   * on an outbound call nobody says anything until we prompt a first turn.
   * The consent line lives in the system instruction; this only cues delivery.
   */
  greet(): void {
    this.#ws?.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[The call has connected. Deliver your opening line now, exactly as instructed.]" }] }],
        turnComplete: true,
      },
    }));
  }

  /**
   * Types a turn as the buyer. Exists so a demo can proceed when a mic is not
   * available, and so the tool path can be tested without synthesising speech.
   */
  sendText(text: string): void {
    this.#ws?.send(JSON.stringify({
      clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
    }));
  }

  /** 16 kHz signed 16-bit PCM. */
  sendAudio(pcm16: Buffer): void {
    if (this.#closed) return;
    if (!this.#ready) { this.#queue.push(pcm16); return; }
    this.#sendAudio(pcm16);
  }

  #sendAudio(pcm16: Buffer): void {
    // `realtimeInput.audio`, not the older `mediaChunks` array.
    this.#ws?.send(JSON.stringify({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=16000", data: pcm16.toString("base64") },
      },
    }));
  }

  close(reason = "closed by caller"): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#ws?.close(); } catch { /* already gone */ }
    this.o.onClose(reason);
  }
}
