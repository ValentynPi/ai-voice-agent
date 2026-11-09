/**
 * ElevenLabs providers for the cascade engine.
 *  - STT: Scribe v2 Realtime over WebSocket (partials + VAD commits, language detection).
 *  - TTS: Eleven v4 Turbo over the Text to Dialogue WebSocket (90+ languages incl. uk, he).
 * The API key stays on the server (xi-api-key header).
 */
import WebSocket from "ws";
import { normalizeLanguageCode } from "./config.js";

const STT_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const TTS_URL = "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input";
/** Premade multilingual voice ("Sarah"), present in every ElevenLabs account. */
export const DEFAULT_ELEVENLABS_VOICE = "EXAVITQu4vr4xnAyxlnn";

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.provider = "elevenlabs";
  return error;
}

/** Scribe error message types -> stable codes the UI can explain. */
export function scribeFailure(message) {
  const type = String(message?.message_type || "");
  if (type === "auth_error") return providerError("elevenlabs_key_invalid", "The ElevenLabs API key was rejected");
  if (type === "quota_exceeded") return providerError("elevenlabs_quota", "The ElevenLabs account is out of credits");
  if (type === "unaccepted_terms") return providerError("elevenlabs_terms", "Accept the ElevenLabs Scribe terms in the ElevenLabs dashboard");
  if (/error|exceeded|limited|overflow|exhausted|throttled|insufficient/.test(type)) {
    return providerError("elevenlabs_stt_error", String(message?.error || type).slice(0, 160));
  }
  return null;
}

/**
 * format: "pcm16k" (browser, PCM16 LE 16 kHz) or "mulaw8k" (Twilio).
 * Resolves once the session started; rejects on auth/terms errors.
 */
export function openScribeStt({
  format = "pcm16k",
  apiKey = process.env.ELEVENLABS_API_KEY,
  onPartial = () => {},
  onCommitted = () => {},
  onError = () => {},
  WebSocketImpl = WebSocket,
  silenceSecs = Number(process.env.CASCADE_STT_SILENCE_SECS) || 0.6,
} = {}) {
  const mulaw = format === "mulaw8k";
  const sampleRate = mulaw ? 8000 : 16000;
  const params = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    audio_format: mulaw ? "ulaw_8000" : "pcm_16000",
    commit_strategy: "vad",
    vad_silence_threshold_secs: String(silenceSecs),
    include_timestamps: "true",
    include_language_detection: "true",
  });
  const ws = new WebSocketImpl(`${STT_URL}?${params}`, { headers: { "xi-api-key": apiKey || "" } });
  let closed = false;
  let pendingPlain = null;
  let started = false;

  const deliver = (text, language) => {
    const clean = String(text || "").trim();
    if (clean) onCommitted(clean, normalizeLanguageCode(language));
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(providerError("elevenlabs_stt_timeout", "ElevenLabs speech-to-text did not start")), 10000);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const type = msg.message_type;
      if (type === "session_started") {
        started = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      const failure = scribeFailure(msg);
      if (failure) {
        clearTimeout(timer);
        if (!started) reject(failure);
        else onError(failure);
        return;
      }
      if (type === "partial_transcript") {
        if (String(msg.text || "").trim()) onPartial(String(msg.text));
        return;
      }
      if (type === "committed_transcript") {
        // The timestamped twin carries language_code; wait briefly for it.
        if (pendingPlain) clearTimeout(pendingPlain.timer);
        const text = msg.text;
        pendingPlain = { text, timer: setTimeout(() => { pendingPlain = null; deliver(text, ""); }, 250) };
        return;
      }
      if (type === "committed_transcript_with_timestamps") {
        if (pendingPlain) { clearTimeout(pendingPlain.timer); pendingPlain = null; }
        deliver(msg.text, msg.language_code);
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const code = res?.statusCode === 401 || res?.statusCode === 403 ? "elevenlabs_key_invalid" : "elevenlabs_stt_error";
      const error = providerError(code, code === "elevenlabs_key_invalid" ? "The ElevenLabs API key was rejected" : `ElevenLabs speech-to-text refused the connection (HTTP ${res?.statusCode})`);
      if (!started) reject(error); else onError(error);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      const wrapped = providerError("elevenlabs_stt_error", error?.message || "ElevenLabs speech-to-text failed");
      if (!started) reject(wrapped); else if (!closed) onError(wrapped);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!started) reject(providerError("elevenlabs_stt_error", "ElevenLabs speech-to-text closed"));
      else if (!closed) onError(providerError("elevenlabs_stt_closed", "ElevenLabs speech-to-text closed"));
    });
  });

  return {
    ready,
    send(buffer) {
      if (closed || ws.readyState !== WebSocket.OPEN || !buffer?.length) return;
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: Buffer.from(buffer).toString("base64"), commit: false, sample_rate: sampleRate }));
    },
    close() {
      if (closed) return;
      closed = true;
      if (pendingPlain) clearTimeout(pendingPlain.timer);
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

export function elevenVoiceFor(language, env = process.env) {
  const code = String(language || "").toUpperCase();
  return String((code && env[`ELEVENLABS_VOICE_ID_${code}`]) || env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE).trim();
}

/**
 * One TTS stream per spoken reply (the language is fixed per reply).
 * send(text) appends a sentence; end() flushes and closes; abort() drops it.
 */
export function openElevenTts({
  language = "",
  format = "pcm16k",
  apiKey = process.env.ELEVENLABS_API_KEY,
  model = process.env.ELEVENLABS_TTS_MODEL || "eleven_v4_turbo",
  voiceId = elevenVoiceFor(language),
  onAudio = () => {},
  WebSocketImpl = WebSocket,
} = {}) {
  const params = new URLSearchParams({ model_id: model, output_format: format === "mulaw8k" ? "ulaw_8000" : "pcm_16000" });
  const code = normalizeLanguageCode(language);
  if (code) params.set("language_code", code);
  const ws = new WebSocketImpl(`${TTS_URL}?${params}`, { headers: { "xi-api-key": apiKey || "" } });
  let open = false;
  let aborted = false;
  let ended = false;
  const queue = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});

  const flushQueue = () => {
    while (open && queue.length) ws.send(JSON.stringify(queue.shift()));
  };
  ws.on("open", () => {
    open = true;
    ws.send(JSON.stringify({ voices: [voiceId] }));
    flushQueue();
  });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (aborted) return;
    if (msg.error) {
      const keyBad = /auth|api key|unauthor/i.test(`${msg.error} ${msg.message}`);
      const quota = /quota|credit/i.test(`${msg.error} ${msg.message}`);
      rejectDone(providerError(keyBad ? "elevenlabs_key_invalid" : quota ? "elevenlabs_quota" : "elevenlabs_tts_error", String(msg.message || msg.error).slice(0, 160)));
      try { ws.close(); } catch { /* ignore */ }
      return;
    }
    if (msg.audio) onAudio(Buffer.from(msg.audio, "base64"));
    if (msg.is_final) resolveDone();
  });
  ws.on("unexpected-response", (_req, res) => {
    rejectDone(providerError(res?.statusCode === 401 ? "elevenlabs_key_invalid" : "elevenlabs_tts_error", `ElevenLabs text-to-speech refused the connection (HTTP ${res?.statusCode})`));
  });
  ws.on("error", (error) => rejectDone(providerError("elevenlabs_tts_error", error?.message || "ElevenLabs text-to-speech failed")));
  ws.on("close", () => (aborted || ended ? resolveDone() : rejectDone(providerError("elevenlabs_tts_error", "ElevenLabs text-to-speech closed early"))));

  return {
    done,
    send(text) {
      const clean = String(text || "").trim();
      if (!clean || aborted || ended) return;
      // flush: speak each finished sentence now instead of waiting for ~40 chars more.
      queue.push({ inputs: [{ text: `${clean} `, voice_id: voiceId }], flush: true });
      flushQueue();
    },
    end() {
      if (aborted || ended) return;
      ended = true;
      queue.push({ close_socket: true });
      flushQueue();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      queue.length = 0;
      try { ws.close(); } catch { /* ignore */ }
      resolveDone();
    },
  };
}
