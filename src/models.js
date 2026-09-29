export const DEFAULT_CHAT_MODEL = "gpt-5.1";
// gpt-5.1 is a text model. The 2026 Realtime session API accepts speech models
// such as gpt-realtime-2.1, which is the documented pair for voice "marin".
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
export const REALTIME_FALLBACKS = ["gpt-realtime-2.1", "gpt-realtime", "gpt-live-1"];
export const CHAT_FALLBACKS = ["gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o-mini"];
export const DEFAULT_VOICE = "marin";

let resolvedChat = null;
let resolvedRealtime = null;

export function resetResolvedModels() {
  resolvedChat = null;
  resolvedRealtime = null;
}

export function chatModel() {
  return resolvedChat || process.env.OPENAI_MODEL || DEFAULT_CHAT_MODEL;
}

export function noteChatModel(model) {
  if (model) resolvedChat = model;
}

export function realtimeModel() {
  return resolvedRealtime || process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
}

export function noteRealtimeModel(model) {
  if (model) resolvedRealtime = model;
}

export function voiceName() {
  return process.env.OPENAI_VOICE || DEFAULT_VOICE;
}

export function uniqueModels(list) {
  return [...new Set(list.filter(Boolean))];
}

export function chatCandidates() {
  return uniqueModels([process.env.OPENAI_MODEL || DEFAULT_CHAT_MODEL, ...CHAT_FALLBACKS]);
}

export function realtimeCandidates() {
  return uniqueModels([
    process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
    ...REALTIME_FALLBACKS,
  ]);
}
