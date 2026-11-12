/**
 * Azure Speech providers for the cascade engine.
 *  - STT: real-time recognition over the Speech WebSocket (universal v2).
 *    The call starts with language identification over a short list
 *    (uk/he/en), then locks to the caller's language; unsure or unheard
 *    speech is re-checked per language (see openAzureStt).
 *  - TTS: neural voices recorded by native speakers (uk-UA Polina/Ostap,
 *    he-IL Hila/Avri). One REST request per sentence; audio is emitted in order.
 */
import crypto from "node:crypto";
import WebSocket from "ws";
import { mulawDecode, mulawToPcm16 } from "../twilio/mulaw.js";
import { normalizeLanguageCode } from "./config.js";

/** Default list for a bare recognizer. Continuous LID allows up to 10 locales; at-start LID allows 4. */
export const AZURE_STT_LANGUAGES = ["uk-UA", "he-IL", "en-US"];

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

export function azureSpeechContext(silenceMs = 600, languages = AZURE_STT_LANGUAGES, { locale = "", priority = "PrioritizeAccuracy", lidMode = "DetectContinuous" } = {}) {
  const lid = locale ? {} : {
    languageId: {
      languages: [...languages],
      mode: lidMode,
      onSuccess: { action: "Recognize" },
      onUnknown: { action: "None" },
      priority,
    },
  };
  return {
    ...lid,
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

function phraseInfo(body) {
  const best = body?.NBest?.[0] || {};
  return {
    confidence: Number.isFinite(Number(best.Confidence)) ? Number(best.Confidence) : null,
    offset: Number(body?.Offset) || 0,
    duration: Number(body?.Duration) || 0,
    lidConfidence: String(body?.PrimaryLanguage?.Confidence || ""),
  };
}

function phraseText(body) {
  return String(body?.DisplayText || body?.NBest?.[0]?.Display || body?.Text || "").trim();
}

/**
 * One Azure recognizer connection.
 * format: "pcm16k" (browser, PCM16 LE 16 kHz) or "mulaw8k" (Twilio, converted to PCM16 8 kHz).
 * `locale` locks it to one language (no language identification); otherwise
 * continuous LID over `languages`. Keeps the last ~30 s of caller audio so an
 * unsure phrase can be re-checked in other languages.
 */
export function openAzureRecognizer({
  format = "pcm16k",
  apiKey = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  onPartial = () => {},
  onCommitted = () => {},
  onError = () => {},
  WebSocketImpl = WebSocket,
  silenceMs = azureSttSilenceMs(),
  languages = AZURE_STT_LANGUAGES,
  locale = "",
  priority = "PrioritizeAccuracy",
  lidMode = "DetectContinuous",
  onNoMatch = () => {},
  onTurnEnd = () => {},
  keepAudioMs = 30000,
} = {}) {
  const mulaw = format === "mulaw8k";
  const sampleRate = mulaw ? 8000 : 16000;
  const connectionId = newId();
  const params = new URLSearchParams({
    format: "detailed",
    ...(locale ? { language: locale } : { lidEnabled: "true" }),
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
  let finished = false;
  let requestId = newId();
  const bytesPerMs = mulaw ? 8 : 32; // input bytes per ms (mulaw 8 kHz, PCM16 16 kHz)
  const ring = []; // [{ at: input byte index, data }]
  let ringBytes = 0;
  let sentBytes = 0; // input bytes sent since the connection opened
  let turnStartByte = 0;
  const context = azureSpeechContext(silenceMs, languages, { locale, priority, lidMode });
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
    turnStartByte = sentBytes;
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
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      const why = `Azure speech-to-text closed${code ? ` (${code}${reason?.length ? ` ${String(reason).slice(0, 80)}` : ""})` : ""}`;
      if (!opened) reject(providerError("azure_stt_error", why));
      else if (!closed) onError(providerError("azure_stt_closed", why));
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
      if (status === "NoMatch" || status === "InitialSilenceTimeout" || status === "BabbleTimeout") {
        onNoMatch(status, phraseInfo(body));
        return;
      }
      if (status === "Error") {
        const wrapped = providerError("azure_stt_error", String(body.RecognitionFailureReason || body.FailureReason || "Azure speech-to-text failed").slice(0, 160));
        if (!closed) onError(wrapped);
        return;
      }
      if (status !== "Success") return;
      const text = phraseText(body);
      if (text) onCommitted(text, phraseLanguage(body) || normalizeLanguageCode(locale), phraseInfo(body));
      return;
    }
    if (path === "turn.end") {
      onTurnEnd();
      if (!closed && !finished) startTurn();
    }
  });

  /** Caller audio (input format) for a phrase's Offset/Duration (100 ns ticks, relative to its turn). */
  // The end pad is generous: a recognizer locked to the wrong language often reports a too-short phrase.
  const audioFor = ({ offset = 0, duration = 0 } = {}, padMs = 300, padAfterMs = Math.max(padMs, 600)) => {
    const from = turnStartByte + Math.floor((offset / 10000 - padMs) * bytesPerMs);
    const to = turnStartByte + Math.ceil(((offset + duration) / 10000 + padAfterMs) * bytesPerMs);
    const parts = [];
    for (const { at, data } of ring) {
      const end = at + data.length;
      if (end <= from || at >= to) continue;
      parts.push(data.subarray(Math.max(0, from - at), Math.min(data.length, to - at)));
    }
    return Buffer.concat(parts);
  };

  return {
    ready,
    audioFor,
    send(buffer) {
      if (closed || finished || ws.readyState !== WebSocket.OPEN || !buffer?.length) return;
      const data = Buffer.from(buffer);
      ring.push({ at: sentBytes, data });
      sentBytes += data.length;
      ringBytes += data.length;
      while (ring.length > 1 && ringBytes - ring[0].data.length >= keepAudioMs * bytesPerMs) ringBytes -= ring.shift().data.length;
      sendAudio(mulaw ? mulawToPcm16(data) : data);
    },
    /** End of audio: the service finishes the last phrase, then sends turn.end. */
    finish() {
      if (closed || finished) return;
      finished = true;
      try { sendAudio(Buffer.alloc(0)); } catch { /* ignore */ }
    },
    close() {
      if (closed) return;
      closed = true;
      try { sendAudio(Buffer.alloc(0)); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

/* ------------------------- language-locked STT ------------------------- */

/** Default listening languages; CASCADE_STT_LANGUAGES (e.g. "uk-UA,he-IL,en-US,es-ES") overrides. */
export const AZURE_CALL_LANGUAGES = ["uk-UA", "he-IL", "en-US"];
/** Unlocked (language identification) phrase at or above this: trust it and lock to its language. */
export const AZURE_LID_TRUST = 0.75;
/**
 * Locked phrase at or above this: keep it without a re-check. Measured on
 * Azure voices: a recognizer locked to the wrong language scores <= 0.32 for
 * uk-UA / en-US, but he-IL scores Ukrainian speech 0.54-0.73 (real Hebrew
 * 0.85-0.89), so Hebrew needs a higher bar.
 */
export const AZURE_LOCKED_TRUST = 0.55;
export const AZURE_LOCKED_TRUST_BY_LOCALE = { "he-IL": 0.8 };
/** When languages compete, he-IL confidence is discounted by this much (it runs high on foreign speech). */
export const AZURE_CONFIDENCE_BIAS = { "he-IL": 0.1 };
/** A re-check result must reach this, and beat the original by AZURE_SWITCH_MARGIN, to switch language. */
export const AZURE_SWITCH_MIN = 0.6;
export const AZURE_SWITCH_MARGIN = 0.1;

export function lockedTrust(locale) {
  return AZURE_LOCKED_TRUST_BY_LOCALE[locale] ?? AZURE_LOCKED_TRUST;
}

/** Confidence comparable across languages. */
export function languageScore(locale, confidence) {
  return (Number(confidence) || 0) - (AZURE_CONFIDENCE_BIAS[locale] || 0);
}
/** A no-match longer than this (ms) is re-checked: the caller said something we could not place. */
export const AZURE_NOMATCH_RECHECK_MS = 350;

const LOCALE_BY_CODE = { uk: "uk-UA", he: "he-IL", en: "en-US", es: "es-ES", ru: "ru-RU", fr: "fr-FR", ar: "ar-SA" };

export function azureCallLanguages(env = process.env, agentLanguage = "") {
  const raw = String(env.CASCADE_STT_LANGUAGES || "").trim();
  let list = raw
    ? raw.split(/[\s,]+/).map((x) => LOCALE_BY_CODE[normalizeLanguageCode(x)] || "").filter(Boolean)
    : [...AZURE_CALL_LANGUAGES];
  const preferred = LOCALE_BY_CODE[normalizeLanguageCode(agentLanguage)];
  if (preferred && !list.includes(preferred)) list.push(preferred);
  list = [...new Set(list)];
  return list.length ? list.slice(0, 10) : [...AZURE_CALL_LANGUAGES];
}

/**
 * Recognize one short clip with a recognizer locked to `locale`. Resolves
 * { locale, text, confidence } (confidence 0 when nothing was recognized).
 */
export function recognizeClipOnce(audio, locale, {
  format = "pcm16k",
  apiKey = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  WebSocketImpl = WebSocket,
  silenceMs = 500,
  timeoutMs = 5000,
} = {}) {
  return new Promise((resolve) => {
    const phrases = [];
    let rec = null;
    let settled = false;
    let failure = "";
    const finish = (error) => {
      if (error?.code && !failure) failure = error.code;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rec?.close(); } catch { /* ignore */ }
      const text = phrases.map((p) => p.text).join(" ").trim();
      const total = phrases.reduce((n, p) => n + (p.duration || 1), 0);
      const confidence = phrases.length
        ? phrases.reduce((n, p) => n + (p.confidence ?? 0) * (p.duration || 1), 0) / total
        : 0;
      resolve(failure && !phrases.length ? { locale, text, confidence, error: failure } : { locale, text, confidence });
    };
    const timer = setTimeout(() => finish({ code: "azure_recheck_timeout" }), timeoutMs);
    try {
      rec = openAzureRecognizer({
        format, apiKey, region, WebSocketImpl, silenceMs, locale,
        keepAudioMs: 0,
        onCommitted: (text, _lang, info) => phrases.push({ text, confidence: info?.confidence, duration: info?.duration }),
        onTurnEnd: () => finish(),
        onError: finish,
      });
    } catch {
      finish();
      return;
    }
    rec.ready.then(() => {
      const bytesPerMs = format === "mulaw8k" ? 8 : 32;
      const fill = format === "mulaw8k" ? 0xff : 0;
      const all = Buffer.concat([Buffer.alloc(100 * bytesPerMs, fill), audio, Buffer.alloc(300 * bytesPerMs, fill)]);
      const frame = 100 * bytesPerMs;
      for (let i = 0; i < all.length; i += frame) rec.send(all.subarray(i, i + frame));
      rec.finish();
    }, finish);
  });
}

/**
 * Tiny energy detector over caller audio (input format). Reports finished
 * speech spans as input byte ranges. Used only to notice speech the
 * recognizer stayed silent on (a he-IL recognizer can ignore English entirely).
 */
export function createSpeechSpans({ format = "pcm16k", onSpan = () => {}, minRms = 350, startFrames = 5, endFrames = 35, minSpeechMs = 350 } = {}) {
  const mulaw = format === "mulaw8k";
  const frameBytes = mulaw ? 160 : 640; // 20 ms
  const bytesPerMs = mulaw ? 8 : 32;
  let carry = Buffer.alloc(0);
  let index = 0; // input bytes consumed
  let floor = 200;
  let run = 0;
  let quiet = 0;
  let span = null;
  const rmsOf = (frame) => {
    let sum = 0;
    let n = 0;
    if (mulaw) for (let i = 0; i < frame.length; i += 1) { const v = mulawDecode(frame[i]); sum += v * v; n += 1; }
    else for (let i = 0; i + 1 < frame.length; i += 2) { const v = frame.readInt16LE(i); sum += v * v; n += 1; }
    return n ? Math.sqrt(sum / n) : 0;
  };
  return {
    push(buffer) {
      let buf = carry.length ? Buffer.concat([carry, buffer]) : buffer;
      let pos = 0;
      for (; pos + frameBytes <= buf.length; pos += frameBytes) {
        const at = index + pos;
        const rms = rmsOf(buf.subarray(pos, pos + frameBytes));
        const loud = rms > Math.max(minRms, floor * 4);
        if (!loud) floor = floor * 0.95 + rms * 0.05; else floor = Math.min(floor * 1.002, 4000);
        if (!span) {
          run = loud ? run + 1 : 0;
          if (run >= startFrames) { span = { from: at - (startFrames - 1) * frameBytes, speech: run }; quiet = 0; }
        } else {
          if (loud) { span.speech += 1; quiet = 0; } else quiet += 1;
          if (quiet >= endFrames) {
            const done = { from: span.from, to: at - (endFrames - 1) * frameBytes, speechMs: span.speech * 20 };
            span = null;
            run = 0;
            if (done.speechMs >= minSpeechMs) onSpan(done);
          }
        }
      }
      index += pos;
      carry = Buffer.from(buf.subarray(pos));
      void bytesPerMs;
    },
    get active() { return Boolean(span); },
  };
}

/**
 * Call-level Azure listening with a language lock:
 *  - Until the caller's language is known: language identification over a
 *    short list (uk/he/en by default; fewer candidates = fewer mix-ups).
 *  - After the first confident phrase: a recognizer locked to that locale
 *    (much more accurate on short phrases like "Дякую").
 *  - An unsure phrase, or speech that matched nothing, is re-recognized from
 *    the kept audio by locked recognizers for each candidate language; the
 *    clearly best one wins. The lock moves only when another language is
 *    clearly better, so the call stays in the caller's language unless they
 *    really switch.
 * onCommitted(text, languageCode, { confidence, locked, rechecked, switched })
 */
export function openAzureStt({
  format = "pcm16k",
  apiKey = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  onPartial = () => {},
  onCommitted = () => {},
  onError = () => {},
  log = () => {},
  WebSocketImpl = WebSocket,
  silenceMs = azureSttSilenceMs(),
  languages = null,
  agentLanguage = "",
  locale: startLocale = "",
  recheck = recognizeClipOnce,
  openRecognizer = openAzureRecognizer,
} = {}) {
  const candidates = languages?.length ? [...languages] : azureCallLanguages(process.env, agentLanguage);
  const bytesPerMs = format === "mulaw8k" ? 8 : 32;
  // Whole-call audio ring (input format, absolute byte index) for re-checks of unheard speech.
  const ring = [];
  let ringBytes = 0;
  let streamBytes = 0;
  let lastHeardAt = 0; // stream byte index when the recognizer last showed it heard something
  let lastUnheardCheck = -Infinity;
  const ringSlice = (from, to) => {
    const parts = [];
    for (const { at, data } of ring) {
      const end = at + data.length;
      if (end <= from || at >= to) continue;
      parts.push(data.subarray(Math.max(0, from - at), Math.min(data.length, to - at)));
    }
    return Buffer.concat(parts);
  };
  const heard = () => { lastHeardAt = streamBytes; };
  let locale = startLocale && candidates.includes(startLocale) ? startLocale : "";
  let closed = false;
  let current = null;
  let pending = []; // audio while a new recognizer connects
  let reconnects = 0;
  let chain = Promise.resolve(); // commits stay in order even when one is re-checked
  const shared = { format, apiKey, region, WebSocketImpl };

  const emit = (text, code, info) => {
    if (closed || !text) return;
    log("stt-commit", `${code || "?"} c=${info.confidence == null ? "?" : info.confidence.toFixed(2)}${info.locked ? " locked" : " lid"}${info.rechecked ? " rechecked" : ""}${info.switched ? " switched" : ""}`);
    onCommitted(text, code, info);
  };

  async function bestOf(audio, locales) {
    if (!audio?.length || !locales.length) return [];
    const results = await Promise.all(locales.map((l) => recheck(audio, l, { ...shared, silenceMs }).catch(() => ({ locale: l, text: "", confidence: 0 }))));
    return results
      .map((r) => ({ ...r, score: r.text ? languageScore(r.locale, r.confidence) : 0 }))
      .sort((a, b) => b.score - a.score);
  }

  let pendingLock = "";
  function lockTo(next, why) {
    if (closed || !next || next === locale) { if (next === locale) pendingLock = ""; return; }
    log("stt-lock", `${locale || "lid"} -> ${next} ${why}`);
    locale = next;
    // Never swap recognizers mid-utterance: wait for the caller to pause.
    if (spans.active) { pendingLock = next; return; }
    pendingLock = "";
    connect();
  }

  function handlePhrase(rec, text, sttCode, info = {}) {
    const lockedNow = rec.locale;
    const confidence = info.confidence ?? 0;
    const trusted = lockedNow ? confidence >= lockedTrust(lockedNow) : confidence >= AZURE_LID_TRUST;
    if (trusted) {
      chain = chain.then(() => {
        emit(text, sttCode, { confidence, locked: Boolean(lockedNow) });
        if (!lockedNow) lockTo(LOCALE_BY_CODE[sttCode], `c=${confidence.toFixed(2)}`);
      });
      return;
    }
    const audio = rec.audioFor(info);
    const others = candidates.filter((l) => !lockedNow || l !== lockedNow);
    const originalLocale = lockedNow || LOCALE_BY_CODE[sttCode] || "";
    const original = { locale: originalLocale, text, confidence, score: languageScore(originalLocale, confidence) };
    const work = bestOf(audio, others);
    chain = chain.then(async () => {
      const results = await work;
      if (closed) return;
      const top = results[0];
      const sameAsOriginal = top && top.locale === original.locale;
      const beats = Boolean(top && top.text && top.confidence >= AZURE_SWITCH_MIN && (sameAsOriginal || top.score >= original.score + AZURE_SWITCH_MARGIN));
      log("stt-recheck", `${original.locale || "?"} c=${confidence.toFixed(2)} -> ${results.map((r) => `${r.locale}=${r.confidence.toFixed(2)}${r.error ? `(${r.error})` : ""}`).join(" ")}`);
      const pick = beats ? top : original;
      const code = normalizeLanguageCode(pick.locale) || sttCode;
      const switched = Boolean(beats && lockedNow && pick.locale !== lockedNow);
      emit(pick.text, code, { confidence: pick.confidence, locked: Boolean(lockedNow), rechecked: true, switched });
      if (beats && pick.locale !== locale) lockTo(pick.locale, `recheck c=${pick.confidence.toFixed(2)}`);
      else if (!locale && !beats && original.locale && confidence >= AZURE_SWITCH_MIN) lockTo(original.locale, "lid");
    });
  }

  function handleNoMatch(rec, status, info = {}) {
    const ms = (info.duration || 0) / 10000;
    log("stt-nomatch", `${status} ${Math.round(ms)}ms ${rec.locale || "lid"}`);
    if (status !== "NoMatch" || ms < AZURE_NOMATCH_RECHECK_MS) return;
    const audio = rec.audioFor(info);
    const work = bestOf(audio, candidates);
    chain = chain.then(async () => {
      const results = await work;
      if (closed) return;
      const top = results[0];
      log("stt-recheck", `nomatch -> ${results.map((r) => `${r.locale}=${r.confidence.toFixed(2)}${r.error ? `(${r.error})` : ""}`).join(" ")}`);
      if (!top?.text || top.confidence < lockedTrust(top.locale)) return;
      const keep = rec.locale && results.find((r) => r.locale === rec.locale && r.text && r.score >= top.score - AZURE_SWITCH_MARGIN);
      const pick = keep || top;
      emit(pick.text, normalizeLanguageCode(pick.locale), { confidence: pick.confidence, locked: Boolean(rec.locale), rechecked: true, switched: Boolean(rec.locale && pick.locale !== rec.locale) });
      if (pick.locale !== locale && pick.confidence >= AZURE_SWITCH_MIN) lockTo(pick.locale, "nomatch");
    });
  }

  /** Speech our detector saw but the recognizer never reacted to: re-check it in every language. */
  function checkUnheard(span) {
    const from = span.from;
    setTimeout(() => {
      if (closed || lastHeardAt >= from || from < lastUnheardCheck) return;
      lastUnheardCheck = span.to;
      const audio = ringSlice(Math.max(0, from - 250 * bytesPerMs), span.to + 250 * bytesPerMs);
      log("stt-unheard", `${span.speechMs}ms ${locale || "lid"}`);
      const work = bestOf(audio, candidates);
      chain = chain.then(async () => {
        const results = await work;
        if (closed || lastHeardAt > from) return; // the recognizer answered after all
        const top = results[0];
        log("stt-recheck", `unheard -> ${results.map((r) => `${r.locale}=${r.confidence.toFixed(2)}${r.error ? `(${r.error})` : ""}`).join(" ")}`);
        if (!top?.text || top.confidence < lockedTrust(top.locale)) return;
        emit(top.text, normalizeLanguageCode(top.locale), { confidence: top.confidence, locked: Boolean(locale), rechecked: true, switched: Boolean(locale && top.locale !== locale) });
        if (top.locale !== locale && top.confidence >= AZURE_SWITCH_MIN) lockTo(top.locale, "unheard");
      });
    }, locale ? 1000 : 2500).unref?.(); // language identification answers later than a locked recognizer
  }
  const spans = createSpeechSpans({ format, onSpan: checkUnheard });

  function retire(old) {
    old.retired = true;
    try { old.inner.finish?.(); } catch { /* ignore */ }
    const timer = setTimeout(() => { try { old.inner.close(); } catch { /* ignore */ } }, 4000);
    timer.unref?.();
    old.closeOnTurnEnd = () => { clearTimeout(timer); try { old.inner.close(); } catch { /* ignore */ } };
  }

  function connect() {
    const previous = current;
    const rec = { locale, inner: null, ready: false, previous };
    current = rec;
    rec.inner = openRecognizer({
      ...shared,
      silenceMs,
      locale,
      languages: candidates,
      onPartial: (t) => { if (!closed) { if (String(t).trim()) heard(); onPartial(t); } },
      onCommitted: (t, code, info) => { if (!closed) { heard(); handlePhrase({ locale: rec.locale, audioFor: rec.inner.audioFor }, t, code, info); } },
      onNoMatch: (status, info) => { if (!closed) { if (status === "NoMatch") heard(); handleNoMatch({ locale: rec.locale, audioFor: rec.inner.audioFor }, status, info); } },
      onTurnEnd: () => { if (rec.retired) rec.closeOnTurnEnd?.(); },
      onError: (error) => {
        if (closed || current !== rec || rec.retired) return;
        log("stt-error", `${error?.code || "error"} ${String(error?.message || "").slice(0, 60)}`);
        if (error?.code === "azure_key_invalid" || reconnects >= 3) { onError(error); return; }
        reconnects += 1;
        connect();
      },
    });
    rec.inner.audioFor ||= () => Buffer.alloc(0);
    const opened = rec.inner.ready.then(() => {
      rec.ready = true;
      rec.previous = null;
      if (current !== rec) { try { rec.inner.close(); } catch { /* ignore */ } return; }
      for (const buf of pending.splice(0)) rec.inner.send(buf);
      // End the old recognizer's audio so a phrase in progress still completes, then drop it.
      // If the caller is mid-utterance, the old one keeps listening until they pause.
      if (previous && spans.active) rec.handover = previous;
      else if (previous) retire(previous);
    });
    if (previous) opened.catch((error) => {
      // Keep listening on the old recognizer if the new one cannot start.
      if (current !== rec || closed) return;
      log("stt-error", `lock failed ${error?.code || ""}`);
      current = previous;
      locale = previous.locale;
    });
    return opened;
  }

  const ready = connect();
  return {
    ready,
    get locale() { return locale; },
    send(buffer) {
      if (closed || !buffer?.length) return;
      const data = Buffer.from(buffer);
      ring.push({ at: streamBytes, data });
      streamBytes += data.length;
      ringBytes += data.length;
      while (ring.length > 1 && ringBytes - ring[0].data.length >= 30000 * bytesPerMs) ringBytes -= ring.shift().data.length;
      spans.push(data);
      if (pendingLock && !spans.active) { pendingLock = ""; connect(); }
      const rec = current;
      if (rec?.handover) {
        if (spans.active) { rec.handover.inner.send(data); return; }
        retire(rec.handover);
        rec.handover = null;
      }
      if (rec?.ready) { rec.inner.send(buffer); return; }
      // While a locked recognizer connects, the previous one keeps listening.
      if (rec?.previous?.ready) { rec.previous.inner.send(buffer); return; }
      pending.push(Buffer.from(buffer));
      if (pending.length > 100) pending.shift(); // ~4 s at 40 ms frames
    },
    close() {
      if (closed) return;
      closed = true;
      pending = [];
      try { current?.inner.close(); } catch { /* ignore */ }
      try { current?.previous?.inner.close(); } catch { /* ignore */ }
      try { current?.handover?.inner.close(); } catch { /* ignore */ }
    },
  };
}
