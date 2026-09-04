/**
 * Outbound audio pacing for Twilio Media Streams.
 *
 * Gemini emits audio in chunks of whatever size a turn produced — often
 * hundreds of milliseconds at once. Twilio expects a steady stream of 20 ms
 * mu-law frames and drops oversized payloads, which is heard as a sentence
 * stopping halfway through. This accumulates whatever arrives and releases it
 * at real-time rate, one frame at a time.
 */

/** 8 kHz mu-law, 20 ms per frame: 160 bytes. */
export const FRAME_BYTES = 160;
export const FRAME_MS = 20;

export class AudioPacer {
  #buf: Buffer = Buffer.alloc(0);
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(private readonly send: (frameB64: string) => void) {}

  /** Queue mu-law bytes for paced delivery. */
  push(mulaw: Buffer): void {
    if (this.#stopped) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, mulaw]) : mulaw;
    this.#ensureRunning();
  }

  #ensureRunning(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => {
      if (this.#buf.length < FRAME_BYTES) {
        // Nothing left to play: stop the timer rather than emit silence, so a
        // pause in the conversation is a pause and not a stream of empty frames.
        if (this.#buf.length === 0) this.#pause();
        return;
      }
      const frame = this.#buf.subarray(0, FRAME_BYTES);
      this.#buf = this.#buf.subarray(FRAME_BYTES);
      this.send(frame.toString("base64"));
    }, FRAME_MS);
  }

  #pause(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  /** Drop everything still queued. Used when the buyer interrupts. */
  clear(): void {
    this.#buf = Buffer.alloc(0);
    this.#pause();
  }

  stop(): void {
    this.#stopped = true;
    this.clear();
  }

  get queuedMs(): number {
    return Math.round((this.#buf.length / FRAME_BYTES) * FRAME_MS);
  }
}

/**
 * Inbound batching. Twilio delivers a 20 ms frame every 20 ms; forwarding each
 * one as its own WebSocket message to Gemini is 50 sends a second of mostly
 * framing overhead. Grouping into ~100 ms cuts that fivefold without adding
 * meaningful delay.
 */
export class InboundBatcher {
  #buf: Buffer[] = [];
  #bytes = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flushTo: (pcm: Buffer) => void,
    private readonly targetMs = 100,
  ) {}

  /** 16 kHz signed 16-bit PCM: 32 bytes per millisecond. */
  push(pcm16: Buffer): void {
    this.#buf.push(pcm16);
    this.#bytes += pcm16.length;
    if (this.#bytes >= this.targetMs * 32) return this.flush();
    if (!this.#timer) this.#timer = setTimeout(() => this.flush(), this.targetMs);
  }

  flush(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (!this.#buf.length) return;
    const out = Buffer.concat(this.#buf, this.#bytes);
    this.#buf = []; this.#bytes = 0;
    this.flushTo(out);
  }

  stop(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#buf = []; this.#bytes = 0;
  }
}
