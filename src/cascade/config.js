/**
 * Cascade voice engine: caller audio -> STT (non-OpenAI) -> OpenAI text model
 * (Bot task, MCP tools, language rules) -> TTS (non-OpenAI) -> caller.
 *
 * Providers and keys come only from the server environment. Nothing here is
 * ever sent to the browser except provider names and missing env var names.
 *
 *   CASCADE_STT = elevenlabs | deepgram | azure
 *   CASCADE_TTS = elevenlabs | azure
 *   Defaults: ElevenLabs for both, unless AZURE_SPEECH_KEY is set and ELEVENLABS_API_KEY is not,
 *   in which case both default to azure.
 *   CASCADE_LLM_MODEL = gpt-6-luna (default)
 *   ELEVENLABS_API_KEY            (Scribe v2 Realtime STT, Eleven v4 Turbo TTS)
 *   ELEVENLABS_VOICE_ID           optional default voice; ELEVENLABS_VOICE_ID_UK / _HE / _RU / _ES / _EN per language
 *   DEEPGRAM_API_KEY              (Nova-3 multilingual STT)
 *   AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (Azure STT + neural TTS, native uk-UA / he-IL voices)
 *   OPENAI_API_KEY                (the brain)
 */

const AZURE_SPEECH = { label: "Azure Speech", env: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"], keyUrl: "https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices" };

export const STT_PROVIDERS = {
  elevenlabs: { label: "ElevenLabs", env: ["ELEVENLABS_API_KEY"], keyUrl: "https://elevenlabs.io/app/settings/api-keys" },
  deepgram: { label: "Deepgram", env: ["DEEPGRAM_API_KEY"], keyUrl: "https://console.deepgram.com/" },
  azure: AZURE_SPEECH,
};

export const TTS_PROVIDERS = {
  elevenlabs: { label: "ElevenLabs", env: ["ELEVENLABS_API_KEY"], keyUrl: "https://elevenlabs.io/app/settings/api-keys" },
  azure: AZURE_SPEECH,
};

export const DEFAULT_CASCADE_LLM = "gpt-6-luna";
/** Tried in order when a model is rejected. gpt-4.1-mini shuts down Jan 14, 2027. */
export const CASCADE_LLM_FALLBACKS = ["gpt-6-luna", "gpt-4.1-mini"];

function pick(table, raw, fallback) {
  const key = String(raw || "").trim().toLowerCase();
  return table[key] ? key : fallback;
}

function hasEnv(env, name) {
  return Boolean(String(env[name] || "").trim());
}

/** Prefer Azure for both sides when its key is set and ElevenLabs is not. */
function autoDefault(env) {
  return hasEnv(env, "AZURE_SPEECH_KEY") && !hasEnv(env, "ELEVENLABS_API_KEY") ? "azure" : "elevenlabs";
}

export function cascadeProviders(env = process.env) {
  const fallback = autoDefault(env);
  return {
    stt: pick(STT_PROVIDERS, env.CASCADE_STT, fallback),
    tts: pick(TTS_PROVIDERS, env.CASCADE_TTS, fallback),
    llm: String(env.CASCADE_LLM_MODEL || DEFAULT_CASCADE_LLM).trim() || DEFAULT_CASCADE_LLM,
  };
}

/**
 * Readiness for the UI and call start. `missing` lists env var names only.
 * `label` is plain text for the agent page: "Needs ElevenLabs key" or "Needs Azure Speech key".
 */
export function cascadeStatus(env = process.env) {
  const providers = cascadeProviders(env);
  const need = [
    { provider: "OpenAI", env: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
    ...STT_PROVIDERS[providers.stt].env.map((name) => ({ provider: STT_PROVIDERS[providers.stt].label, env: name, keyUrl: STT_PROVIDERS[providers.stt].keyUrl })),
    ...TTS_PROVIDERS[providers.tts].env.map((name) => ({ provider: TTS_PROVIDERS[providers.tts].label, env: name, keyUrl: TTS_PROVIDERS[providers.tts].keyUrl })),
  ];
  const seen = new Set();
  const missing = [];
  for (const item of need) {
    if (seen.has(item.env)) continue;
    seen.add(item.env);
    if (!String(env[item.env] || "").trim()) missing.push(item);
  }
  const names = [...new Set(missing.map((item) => item.provider))];
  const onlyRegion = missing.length === 1 && /REGION/.test(missing[0].env);
  const label = !missing.length
    ? `Ready: ${STT_PROVIDERS[providers.stt].label} listening, ${providers.llm} thinking, ${TTS_PROVIDERS[providers.tts].label} speaking`
    : onlyRegion
      ? `Needs ${names[0]} region`
      : `Needs ${names.join(" and ")} ${names.length > 1 ? "keys" : "key"}`;
  return {
    ready: missing.length === 0,
    stt: providers.stt,
    tts: providers.tts,
    llm: providers.llm,
    sttLabel: STT_PROVIDERS[providers.stt].label,
    ttsLabel: TTS_PROVIDERS[providers.tts].label,
    missing: missing.map(({ provider, env: name, keyUrl }) => ({ provider, env: name, keyUrl })),
    label,
  };
}

/** Which engine a call really uses: cascade only when the agent asks for it and keys exist. */
export function resolveVoiceEngine(agent, env = process.env) {
  const wanted = agent?.voiceEngine === "cascade" ? "cascade" : "realtime";
  if (wanted !== "cascade") return { engine: "realtime", wanted, status: null };
  const status = cascadeStatus(env);
  return { engine: status.ready ? "cascade" : "realtime", wanted, status };
}

/** STT/LLM language code from a provider's code ("ukr", "uk-UA", "heb", "iw"). */
const ISO3 = { ukr: "uk", heb: "he", rus: "ru", eng: "en", spa: "es", fra: "fr", ara: "ar", iw: "he" };
export const CASCADE_LANGUAGES = ["uk", "he", "ru", "en", "es", "fr", "ar"];
export function normalizeLanguageCode(raw) {
  const code = String(raw || "").trim().toLowerCase().split(/[-_]/)[0];
  const short = ISO3[code] || code;
  return CASCADE_LANGUAGES.includes(short) ? short : "";
}
