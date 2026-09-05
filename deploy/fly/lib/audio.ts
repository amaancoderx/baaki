/**
 * Twilio Media Streams carry 8 kHz G.711 mu-law. Gemini Live wants 16 kHz
 * signed 16-bit PCM in and returns 24 kHz PCM out. Both conversions happen
 * here, and both directions have to resample as well as re-encode.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Decode one mu-law byte to a signed 16-bit sample. */
export function muLawToPcm(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

export function pcmToMuLaw(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function muLawBufferToPcm16(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = muLawToPcm(buf[i]!);
  return out;
}

export function pcm16ToMuLawBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcmToMuLaw(pcm[i]!);
  return out;
}

/**
 * Linear resample. Speech at these rates does not need a windowed filter, and
 * a simple interpolation keeps the per-packet cost low enough to stay ahead of
 * a real-time stream.
 */
export function resample(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return input;
  const ratio = from / to;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, input.length - 1);
    const frac = pos - a;
    out[i] = (input[a]! * (1 - frac) + input[b]! * frac) | 0;
  }
  return out;
}

export const int16ToBuffer = (pcm: Int16Array): Buffer =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

export const bufferToInt16 = (buf: Buffer): Int16Array =>
  new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));

/** Twilio mu-law 8 kHz → Gemini PCM 16 kHz. */
/**
 * Gain applied to the buyer's audio before it reaches the model.
 *
 * A mu-law phone line arrives quiet: measured speech peaked at 0.13 with a
 * noise floor of 0.0002. The session runs START_SENSITIVITY_LOW, which exists
 * because a sensitive detector read line noise as speech and made her restart
 * her sentences. That left a narrow band where a buyer speaking normally never
 * tripped the detector at all, and the call went silent after the greeting.
 *
 * Lifting the whole signal keeps the ~30x separation between speech and the
 * noise floor intact, so speech clears the threshold and the noise still does
 * not. Turning sensitivity back up would have closed the gap from the wrong
 * end and brought the restarts back.
 */
const INBOUND_GAIN = Number(process.env.VOICE_INBOUND_GAIN ?? 4);

function amplify(pcm: Int16Array, gain: number): Int16Array {
  if (gain === 1) return pcm;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! * gain;
    // Clamp rather than wrap. A wrapped sample is a loud click, and a click is
    // exactly the thing a speech detector should not be hearing.
    pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return pcm;
}

export const twilioToGemini = (payloadB64: string): Buffer =>
  int16ToBuffer(amplify(resample(muLawBufferToPcm16(Buffer.from(payloadB64, "base64")), 8000, 16000), INBOUND_GAIN));

/** Gemini PCM 24 kHz → Twilio mu-law 8 kHz. */
export const geminiToTwilio = (pcm24: Buffer): string =>
  pcm16ToMuLawBuffer(resample(bufferToInt16(pcm24), 24000, 8000)).toString("base64");
