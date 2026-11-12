/** G.711 μ-law helpers for ducking the agent's phone audio (Twilio streams μ-law 8 kHz). */
const BIAS = 0x84;
const CLIP = 32635;

export function mulawDecode(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

export function mulawEncode(sample) {
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = Int16Array.from({ length: 256 }, (_, i) => mulawDecode(i));

/** Scale a base64 μ-law payload by `gain` (0..1). */
export function scaleMulawBase64(payload, gain) {
  if (!payload || gain >= 1) return payload;
  const bytes = Buffer.from(payload, "base64");
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = mulawEncode(DECODE[bytes[i]] * gain);
  return bytes.toString("base64");
}

/** Playback length of a base64 μ-law payload at 8 kHz, in ms. */
export function mulawDurationMs(payload) {
  if (!payload) return 0;
  const len = String(payload).length;
  const pad = String(payload).endsWith("==") ? 2 : String(payload).endsWith("=") ? 1 : 0;
  return ((len * 3) / 4 - pad) / 8;
}

/** Expand G.711 μ-law bytes to little-endian PCM16 (same sample rate). */
export function mulawToPcm16(buffer) {
  const src = Buffer.from(buffer || []);
  const out = Buffer.allocUnsafe(src.length * 2);
  for (let i = 0; i < src.length; i += 1) out.writeInt16LE(DECODE[src[i]], i * 2);
  return out;
}
