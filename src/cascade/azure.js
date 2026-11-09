/**
 * Azure neural TTS (alternative to ElevenLabs). Each language gets a voice
 * recorded by native speakers (uk-UA Polina/Ostap, he-IL Hila/Avri), which is
 * the most reliable way to have no foreign accent. One REST request per
 * sentence; requests overlap but audio is emitted strictly in order.
 */
import { normalizeLanguageCode } from "./config.js";

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
