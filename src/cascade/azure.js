/**
 * Azure Speech providers for the cascade engine.
 *  - STT: real-time recognition over the Speech WebSocket (universal v2), with
 *    continuous language identification (uk/he/en/es/ru) and fast endpointing.
 *  - TTS: neural voices recorded by native speakers (uk-UA Polina/Ostap,
 *    he-IL Hila/Avri). One REST request per sentence; audio is emitted in order.
 */
import crypto from "node:crypto";
import WebSocket from "ws";
import { mulawToPcm16 } from "../twilio/mulaw.js";
import { normalizeLanguageCode } from "./config.js";

/** Continuous LID allows up to 10 locales; at-start LID allows 4. */
export const AZURE_STT_LANGUAGES = ["uk-UA", "he-IL", "en-US", "es-ES", "ru-RU"];

export const AZURE_VOICES = {
  uk: { locale: "uk-UA", female: "uk-UA-PolinaNeural", male: "uk-UA-OstapNeural" },
  he: { locale: "he-IL", female: "he-IL-HilaNeural", male: "he-IL-AvriNeural" },
  ru: { locale: "ru-RU", female: "ru-RU-SvetlanaNeural", male: "ru-RU-DmitryNeural" },
  es: { locale: "es-ES", female: "es-ES-ElviraNeural", male: "es-ES-AlvaroNeural" },
  en: { locale: "en-US", female: "en-US-AvaNeural", male: "en-US-AndrewNeural" },
  fr: { locale: "fr-FR", female: "fr-FR-DeniseNeural", male: "fr-FR-HenriNeural" },
  ar: { locale: "ar-SA", female: "ar-SA-ZariyahNeural", male: "ar-SA-HamedNeural" },
};

export function azureVoiceFor(language, env = process.env) {
  const code = normalizeLanguageCode(language) || "en";
  const entry = AZURE_VOICES[code] || AZURE_VOICES.en;
  const override = String(env[`AZURE_TTS_VOICE_${code.toUpperCase()}`] || "").trim();
  const gender = String(env.AZURE_TTS_GENDER || "female").toLowerCase() === "male" ? "male" : "female";
  return { locale: entry.locale, voice: override || entry[gender] };
}

function xmlEscape(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

export function azureSsml(text, language) {
  const { locale, voice } = azureVoiceFor(language);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}">${xmlEscape(text)}</voice></speak>`;
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.provider = "azure";
  return error;
}

export function openAzureTts({
  language = "",
  format = "pcm16k",
  apiKey = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  onAudio = () => {},
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const url = `https://${String(region || "").trim()}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const outputFormat = format === "mulaw8k" ? "raw-8khz-8bit-mono-mulaw" : "raw-16khz-16bit-mono-pcm";
  let chain = Promise.resolve();
  let aborted = false;
  let ended = false;
  let failure = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});

  const request = (text) => fetchImpl(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey || "",
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": outputFormat,
      "User-Agent": "voice-desk-cascade",
    },
    body: azureSsml(text, language),
    signal: controller.signal,
  });

  return {
    done,
    send(text) {
      const clean = String(text || "").trim();
      if (!clean || aborted || ended) return;
      const pending = request(clean); // starts now, overlaps the previous sentence
      pending.catch(() => {});
      chain = chain.then(async () => {
        if (aborted || failure) return;
        const res = await pending;
        if (!res.ok) {
          const code = res.status === 401 || res.status === 403 ? "azure_key_invalid" : res.status === 429 ? "azure_busy" : "azure_tts_error";
          throw providerError(code, code === "azure_key_invalid" ? "The Azure Speech key or region was rejected" : `Azure text-to-speech failed (HTTP ${res.status})`);
        }
        if (res.body?.getReader) {
          const reader = res.body.getReader();
          for (;;) {
            const { value, done: finished } = await reader.read();
            if (finished || aborted) break;
            if (value?.length) onAudio(Buffer.from(value));
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          if (!aborted && buf.length) onAudio(buf);
        }
      }).catch((error) => {
        if (aborted) return;
        failure = error?.code ? error : providerError("azure_tts_error", error?.message || "Azure text-to-speech failed");
        rejectDone(failure);
      });
    },
    end() {
      if (aborted || ended) return;
      ended = true;
      chain.then(() => (failure ? null : resolveDone()));
    },
    abort() {
      if (aborted) return;
      aborted = true;
      try { controller.abort(); } catch { /* ignore */ }
      resolveDone();
    },
  };
}

export function azureSttSilenceMs(env = process.env) {
  const endpoint = Number(env.CASCADE_STT_ENDPOINT_MS);
  if (Number.isFinite(endpoint) && endpoint > 0) return Math.round(endpoint);
  const secs = Number(env.CASCADE_STT_SILENCE_SECS);
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  return 600;
}

export function azureSpeechContext(silenceMs = 600, languages = AZURE_STT_LANGUAGES) {
  return {
    languageId: {
      languages: [...languages],
      mode: "DetectContinuous",
      onSuccess: { action: "Recognize" },
      onUnknown: { action: "None" },
      priority: "PrioritizeLatency",
    },
    phraseDetection: {
      mode: "Conversation",
      conversation: {
        segmentation: {
          mode: "Custom",
          segmentationSilenceTimeoutMs: silenceMs,
        },
      },
    },
    phraseOutput: {
      interimResults: { resultType: "Auto" },
      phraseResults: { resultType: "Always" },
    },
  };
}

export function pcmWavHeader(sampleRate, dataSize = 0x7ffff000) {
  const buf = Buffer.alloc(44);
  const rate = Number(sampleRate) || 16000;
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function newId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function textFrame(path, requestId, body) {
  return [
    `Path: ${path}`,
    `X-RequestId: ${requestId}`,
    `X-Timestamp: ${new Date().toISOString()}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    JSON.stringify(body),
  ].join("\r\n");
}

export function frameAzureAudio(requestId, payload) {
  const headers = [
    "Path: audio",
    `X-RequestId: ${requestId}`,
    `X-Timestamp: ${new Date().toISOString()}`,
    "Content-Type: audio/x-wav",
    "",
  ].join("\r\n");
  const headerBuf = Buffer.from(headers, "utf8");
  const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(2 + headerBuf.length + body.length);
  out.writeUInt16BE(headerBuf.length, 0);
  headerBuf.copy(out, 2);
  body.copy(out, 2 + headerBuf.length);
  return out;
}

function parseHeaderBlock(block) {
  const headers = {};
  for (const line of String(block || "").split(/\r?\n/)) {
    const cut = line.indexOf(":");
    if (cut <= 0) continue;
    headers[line.slice(0, cut).trim().toLowerCase()] = line.slice(cut + 1).trim();
  }
  return headers;
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Parse a Speech WebSocket text or binary frame into { path, body }. */
export function parseAzureMessage(raw) {
  if (Buffer.isBuffer(raw) && raw.length >= 2) {
    const headerLength = raw.readUInt16BE(0);
    if (headerLength > 0 && headerLength < 8192 && raw.length >= 2 + headerLength && raw[0] === 0) {
      const headers = parseHeaderBlock(raw.subarray(2, 2 + headerLength).toString("utf8"));
      if (headers.path) {
        const text = raw.subarray(2 + headerLength).toString("utf8");
        return { path: headers.path, body: tryJson(text) || {}, headers };
      }
    }
  }
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const split = text.split("\r\n\r\n");
  if (split.length >= 2 && /path\s*:/i.test(split[0])) {
    const headers = parseHeaderBlock(split[0]);
    return { path: headers.path || "", body: tryJson(split.slice(1).join("\r\n\r\n")) || {}, headers };
  }
  return { path: "", body: tryJson(text) || {}, headers: {} };
}

function phraseLanguage(body) {
  return normalizeLanguageCode(
    body?.PrimaryLanguage?.Language
    || body?.NBest?.[0]?.Locale
    || body?.NBest?.[0]?.Language
    || body?.Language
    || "",
  );
}

function phraseText(body) {
  return String(body?.DisplayText || body?.NBest?.[0]?.Display || body?.Text || "").trim();
}

/**
 * format: "pcm16k" (browser, PCM16 LE 16 kHz) or "mulaw8k" (Twilio, converted to PCM16 8 kHz).
 * Continuous language identification follows the caller turn by turn.
 */
export function openAzureStt({
  format = "pcm16k",
  apiKey = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  onPartial = () => {},
  onCommitted = () => {},
  onError = () => {},
  WebSocketImpl = WebSocket,
  silenceMs = azureSttSilenceMs(),
  languages = AZURE_STT_LANGUAGES,
} = {}) {
  const mulaw = format === "mulaw8k";
  const sampleRate = mulaw ? 8000 : 16000;
  const connectionId = newId();
  const params = new URLSearchParams({
    format: "detailed",
    lidEnabled: "true",
    segmentationSilenceTimeoutMs: String(silenceMs),
    "X-ConnectionId": connectionId,
  });
  const url = `wss://${String(region || "").trim()}.stt.speech.microsoft.com/stt/speech/universal/v2?${params}`;
  const ws = new WebSocketImpl(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey || "",
      "X-ConnectionId": connectionId,
    },
  });
  let closed = false;
  let opened = false;
  let requestId = newId();
  const context = azureSpeechContext(silenceMs, languages);
  const header = pcmWavHeader(sampleRate);
  const speechConfig = {
    context: {
      system: { name: "voice-desk-cascade", version: "1.0.0", build: "Node", lang: "JavaScript" },
      os: { platform: "Node", name: "Node.js", version: process.versions.node },
    },
  };

  const sendText = (path, body, id = requestId) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(textFrame(path, id, body));
  };
  const sendAudio = (payload, id = requestId) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(frameAzureAudio(id, payload));
  };
  const startTurn = () => {
    requestId = newId();
    sendText("speech.context", context, requestId);
    sendAudio(header, requestId);
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(providerError("azure_stt_timeout", "Azure speech-to-text did not start")), 10000);
    ws.on("open", () => {
      opened = true;
      sendText("speech.config", speechConfig, requestId);
      startTurn();
      clearTimeout(timer);
      resolve();
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const code = res?.statusCode === 401 || res?.statusCode === 403 ? "azure_key_invalid" : res?.statusCode === 429 ? "azure_busy" : "azure_stt_error";
      const error = providerError(code, code === "azure_key_invalid" ? "The Azure Speech key or region was rejected" : `Azure speech-to-text refused the connection (HTTP ${res?.statusCode})`);
      if (!opened) reject(error); else onError(error);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      const wrapped = providerError("azure_stt_error", error?.message || "Azure speech-to-text failed");
      if (!opened) reject(wrapped); else if (!closed) onError(wrapped);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!opened) reject(providerError("azure_stt_error", "Azure speech-to-text closed"));
      else if (!closed) onError(providerError("azure_stt_closed", "Azure speech-to-text closed"));
    });
  });

  ws.on("message", (raw) => {
    const msg = parseAzureMessage(raw);
    const path = String(msg.path || "").toLowerCase();
    const body = msg.body || {};
    if (path === "speech.hypothesis" || path === "speech.fragment") {
      const text = phraseText(body);
      if (text) onPartial(text);
      return;
    }
    if (path === "speech.phrase") {
      const status = String(body.RecognitionStatus || "");
      if (status === "Error") {
        const wrapped = providerError("azure_stt_error", String(body.RecognitionFailureReason || body.FailureReason || "Azure speech-to-text failed").slice(0, 160));
        if (!closed) onError(wrapped);
        return;
      }
      if (status !== "Success") return;
      const text = phraseText(body);
      if (text) onCommitted(text, phraseLanguage(body));
      return;
    }
    if (path === "turn.end" && !closed) startTurn();
  });

  return {
    ready,
    send(buffer) {
      if (closed || ws.readyState !== WebSocket.OPEN || !buffer?.length) return;
      sendAudio(mulaw ? mulawToPcm16(buffer) : Buffer.from(buffer));
    },
    close() {
      if (closed) return;
      closed = true;
      try { sendAudio(Buffer.alloc(0)); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}
