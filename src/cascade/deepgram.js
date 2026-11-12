/**
 * Deepgram Nova-3 multilingual streaming STT (alternative to ElevenLabs Scribe).
 * language=multi + hints for the desk's caller languages; interim results are
 * partials, a speech_final / UtteranceEnd closes the caller's turn.
 */
import WebSocket from "ws";
import { normalizeLanguageCode } from "./config.js";

const URL_BASE = "wss://api.deepgram.com/v1/listen";

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.provider = "deepgram";
  return error;
}

export function openDeepgramStt({
  format = "pcm16k",
  apiKey = process.env.DEEPGRAM_API_KEY,
  onPartial = () => {},
  onCommitted = () => {},
  onError = () => {},
  WebSocketImpl = WebSocket,
} = {}) {
  const mulaw = format === "mulaw8k";
  const params = new URLSearchParams({
    model: "nova-3",
    language: "multi",
    encoding: mulaw ? "mulaw" : "linear16",
    sample_rate: mulaw ? "8000" : "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    endpointing: String(Number(process.env.CASCADE_STT_ENDPOINT_MS) || 500),
    utterance_end_ms: "1000",
    vad_events: "true",
  });
  for (const hint of ["uk", "he", "ru", "en", "es"]) params.append("language_hint", hint);
  const ws = new WebSocketImpl(`${URL_BASE}?${params}`, { headers: { Authorization: `Token ${apiKey || ""}` } });
  let closed = false;
  let opened = false;
  let finals = [];
  let finalLang = "";

  const commit = () => {
    const text = finals.join(" ").replace(/\s+/g, " ").trim();
    const lang = finalLang;
    finals = [];
    finalLang = "";
    if (text) onCommitted(text, lang);
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(providerError("deepgram_timeout", "Deepgram speech-to-text did not start")), 10000);
    ws.on("open", () => { opened = true; clearTimeout(timer); resolve(); });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const code = res?.statusCode === 401 || res?.statusCode === 403 ? "deepgram_key_invalid" : res?.statusCode === 402 ? "deepgram_quota" : "deepgram_error";
      reject(providerError(code, code === "deepgram_key_invalid" ? "The Deepgram API key was rejected" : `Deepgram refused the connection (HTTP ${res?.statusCode})`));
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      const wrapped = providerError("deepgram_error", error?.message || "Deepgram failed");
      if (!opened) reject(wrapped); else if (!closed) onError(wrapped);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!opened) reject(providerError("deepgram_error", "Deepgram closed"));
      else if (!closed) onError(providerError("deepgram_closed", "Deepgram closed"));
    });
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "UtteranceEnd") { commit(); return; }
    if (msg.type !== "Results") return;
    const alt = msg.channel?.alternatives?.[0] || {};
    const text = String(alt.transcript || "").trim();
    const lang = normalizeLanguageCode(alt.languages?.[0] || msg.channel?.detected_language || "");
    if (msg.is_final) {
      if (text) { finals.push(text); if (lang) finalLang = lang; }
      if (msg.speech_final) commit();
      else if (finals.length) onPartial(finals.join(" "));
      return;
    }
    if (text) onPartial([...finals, text].join(" "));
  });

  return {
    ready,
    send(buffer) {
      if (closed || ws.readyState !== WebSocket.OPEN || !buffer?.length) return;
      ws.send(Buffer.from(buffer));
    },
    close() {
      if (closed) return;
      closed = true;
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}
