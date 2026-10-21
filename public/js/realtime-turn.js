/**
 * Shared Realtime turn gate for browser dialers and the Twilio media bridge.
 *
 * OpenAI rejects response.create while a response is still active
 * ("conversation already has an active response"). A follow-up that is
 * dropped leaves the caller in silence. Worse, treating every
 * speech_started as barge-in bumps the tool epoch and clears the queued
 * spoken follow-up during a tool wait — so weather and other MCP turns
 * never speak, later turns race, and the model looks like it "didn't
 * understand" because a silence fallback or stale create collided with
 * the caller's next audio.
 *
 * Rules:
 * - Queue at most one spoken follow-up until response.done / cancelled.
 * - Only treat speech_started as barge-in when a response is actually active.
 * - Never silence-fallback on cancelled/incomplete (interrupted) turns.
 * - On an active-response error, requeue and drain after the next settle.
 */

import { classifyCallerTranscript, detectCallerLanguage, isClearLanguageTurn, resolveReplyLanguage, spokenFailure, languageName } from "./caller-language.js";

export const TOOL_TURN_TIMEOUT_MS = 10000;
export const TOOL_FETCH_TIMEOUT_MS = 15000;
/** First still-looking line. Fast tools return before this and skip it. */
export const TOOL_FILLER_AFTER_MS = 1500;

const AUDIO_EVENT = new Set([
  "output_audio_buffer.started",
  "response.output_audio.delta",
  "response.audio.delta",
  "response.output_audio_transcript.delta",
  "response.audio_transcript.delta",
  "response.output_audio.done",
  "response.audio.done",
]);

export function createResponseGate() {
  return {
    botTask: "",
    active: false,
    epoch: 0,
    heardAudio: false,
    fallbackArmed: false,
    userText: "",
    seen: new Set(),
    tools: new Map(),
    turnNames: [],
    turnOk: false,
    turnFailed: false,
    pendingCreates: [],
    /** True when pendingCreates[0] is the one still-looking line, which may speak during a tool. */
    pendingFiller: false,
    /** session.update held until the model is not speaking, so it cannot cut a reply. */
    pendingSession: null,
    /** Caller turn in flight. A session.update now would delay the first audio. */
    holdSession: false,
    lastSent: null,
    /** True when a create was rejected as "active response" and is waiting for idle. */
    waitingForIdle: false,
    callerLanguage: "",
    /** Transcript of the reply in flight, to tell whether a restart is needed. */
    replyText: "",
    /** item_id -> ms of caller speech (from VAD start/stop), for barge-in. */
    speechStart: new Map(),
    speechMs: new Map(),
    lastReply: null,
    replyRetried: false,
    toolRounds: 0,
    toolStartedAt: 0,
    fillerUsed: false,
    fillerTimer: null,
  };
}

export function failureLine(name, userText = "") {
  if (isWeatherTopic(name) || isWeatherTopic(userText)) return "I can't get the weather right now.";
  return "I can't do that right now.";
}

export function isWeatherTopic(value) {
  return /weather|forecast|temperature|clima|tiempo|lluvia|meteo|\brain\b/i.test(String(value || ""));
}

export function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function noteCallerSpeech(gate, text) {
  gate.fallbackArmed = true;
  gate.holdSession = true;
  const clean = String(text || "").trim();
  if (!clean) return gate.callerLanguage || "";
  const next = resolveReplyLanguage(gate.callerLanguage || "", clean);
  if (next) gate.callerLanguage = next;
  // A place name or noisy fragment must not replace the question the tool will answer.
  if (!gate.userText || isClearLanguageTurn(clean)) gate.userText = clean;
  return gate.callerLanguage || "";
}

/**
 * Apply a late transcript to the live turn. create_response often starts before
 * transcription finishes, so English Bot-task text can win the first reply.
 * When the caller's language becomes clear, rewrite queued spoken events and,
 * if a no-tool reply is already active, cancel+restart in that language.
 */
export function applyCallerTranscript(gate, text) {
  const previous = gate.callerLanguage || "";
  noteCallerSpeech(gate, text);
  const language = gate.callerLanguage || "";
  const changed = Boolean(language) && language !== previous;
  rewritePendingSpoken(gate);
  const out = { language, previous, changed, restart: false };
  // Only restart a wrong-language auto-reply when nothing is already queued.
  // Queued tool answers / fillers were rewritten above; do not replace them.
  // Do not cut a reply that is already speaking the caller's language.
  if (changed && gate.active && gate.tools.size === 0 && gate.pendingCreates.length === 0
    && !replyInLanguage(gate.replyText, language)) {
    out.restart = true;
    gate.pendingCreates = [languageRestartEvent(gate.userText, language)];
    gate.pendingFiller = false;
    gate.fallbackArmed = false;
  }
  return out;
}

/**
 * Per-reply language nudge, kept to one line: it is billed as new input on
 * every response (the session instructions are cached, this is not).
 */
export function shortLanguageLine(code, text = "") {
  const name = languageName(code);
  if (name) return `Reply ONLY in ${name}.`;
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  return clean ? `Reply ONLY in the language of the caller's words: "${clean}".` : "Reply in the caller's language.";
}

function languageRestartEvent(userText, established) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "auto",
      instructions: `${shortLanguageLine(resolveReplyLanguage(established, userText) || established, userText)} The caller already spoke this turn. Answer now in that language.`,
    },
  };
}

function rewritePendingSpoken(gate) {
  if (!gate.pendingCreates.length) return;
  const userText = gate.userText || "";
  const code = gate.callerLanguage || "";
  gate.pendingCreates = gate.pendingCreates.map((event) => {
    if (!event || event.type !== "response.create") return event;
    const instructions = String(event.response?.instructions || "");
    if (gate.pendingFiller || /Still looking\.|Ще дивлюся\.|Sigo mirando\.|Ещё смотрю\.|Je regarde encore\./i.test(instructions)) {
      return toolFillerEvent(userText, code);
    }
    if (/Speak the tool result|tool failed, timed out, or is missing/i.test(instructions)) {
      const failed = /tool failed, timed out, or is missing/i.test(instructions);
      const name = isWeatherTopic(userText) || isWeatherTopic(instructions) ? "weather" : "";
      return toolFollowUpEvent(name, failed, userText, code);
    }
    if (/You produced no speech\.|didn't catch that|не розчув|no te he oído|не расслышал/i.test(instructions)) {
      return silenceFallbackEvent(userText, code);
    }
    if (/Reply only in |Their words, unchanged:/i.test(instructions)) {
      return languageRestartEvent(userText, code);
    }
    return {
      ...event,
      response: {
        ...(event.response || {}),
        instructions: `${shortLanguageLine(code, userText)} ${instructions}`.trim(),
      },
    };
  });
}


/**
 * Real barge-in only while a response is active (model speaking / streaming).
 * Speech during a tool wait must NOT bump the epoch or clear the queued
 * spoken follow-up — that was dropping replies and leaving both dialers silent.
 * Returns true when the barge-in invalidated an in-flight turn.
 */
export function noteBargeIn(gate) {
  gate.fallbackArmed = true;
  gate.holdSession = true;
  if (!gate.active) {
    // Idle or waiting on MCP: keep queued follow-ups and the tool epoch.
    // If a create is stuck behind a phantom "active response" race, drop it —
    // semantic VAD create_response will answer this new caller turn.
    if (gate.waitingForIdle) {
      gate.pendingCreates = [];
      gate.pendingFiller = false;
      gate.waitingForIdle = false;
      gate.lastSent = null;
    }
    return false;
  }
  gate.epoch += 1;
  gate.pendingCreates = [];
  gate.pendingFiller = false;
  gate.lastSent = null;
  gate.heardAudio = false;
  gate.waitingForIdle = false;
  return true;
}

export function functionCallsFrom(event) {
  const calls = [];
  if (event?.type === "response.function_call_arguments.done" && event.name && event.call_id) {
    calls.push({ name: event.name, callId: event.call_id, arguments: event.arguments });
  }
  const item = event?.item;
  if (event?.type === "response.output_item.done" && item?.type === "function_call" && item.name && item.call_id) {
    calls.push({ name: item.name, callId: item.call_id, arguments: item.arguments });
  }
  if (event?.type === "response.done" && Array.isArray(event.response?.output)) {
    for (const output of event.response.output) {
      if (output?.type === "function_call" && output.name && (output.call_id || output.callId)) {
        calls.push({
          name: output.name,
          callId: output.call_id || output.callId,
          arguments: output.arguments,
        });
      }
    }
  }
  return calls;
}

export function functionOutputEvent(callId, output) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output ?? { error: "Tool failed" }),
    },
  };
}

export function toolFollowUpEvent(name, failed, userText = "", established = "", { allowMore = false } = {}) {
  const line = spokenFailure(name, userText, established);
  const turn = shortLanguageLine(resolveReplyLanguage(established, userText) || established, userText);
  // The how-to-speak-a-result rules live in the cached session instructions.
  const more = allowMore ? " If it only identifies the place, call the weather lookup first." : "";
  const instructions = failed
    ? `${turn} The tool failed, timed out, or is missing. Say this, then stop: ${line}`
    : `${turn} Speak the tool result in one or two short sentences, only its facts.${more}`;
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: failed || !allowMore ? "none" : "auto",
      instructions,
    },
  };
}

const LOOKING = {
  uk: "Ще дивлюся.",
  es: "Sigo mirando.",
  en: "Still looking.",
  ru: "Ещё смотрю.",
  fr: "Je regarde encore.",
  ar: "ما زلت أبحث.",
  he: "עדיין בודק.",
};

export function stillLookingLine(code) {
  return LOOKING[code] || LOOKING.en;
}

export function toolFillerEvent(userText = "", established = "") {
  const code = resolveReplyLanguage(established, userText) || established || "en";
  const name = languageName(code) || "the caller's language";
  const line = stillLookingLine(code);
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "none",
      instructions: `Say exactly this, in ${name}, then stop: ${line}`,
    },
  };
}

export function silenceFallbackEvent(userText, established = "") {
  const missed = {
    uk: "Вибачте, я не розчув. Повторіть, будь ласка.",
    es: "Perdona, no te he oído. ¿Puedes repetirlo?",
    en: "Sorry, I didn't catch that. Could you say it again?",
    ru: "Извините, я не расслышал. Повторите, пожалуйста.",
    fr: "Pardon, je n'ai pas compris. Pouvez-vous répéter ?",
  };
  const code = resolveReplyLanguage(established, userText) || established || "en";
  const line = isWeatherTopic(userText)
    ? spokenFailure("weather", userText, code)
    : (missed[code] || missed.en);
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "none",
      instructions: `${shortLanguageLine(code, userText)} You produced no speech. Say this, then stop: ${line}`,
    },
  };
}

export function shouldHoldForSpeech(gate) {
  return Boolean(gate.active || gate.tools.size > 0 || gate.pendingCreates.length > 0 || gate.waitingForIdle);
}

/**
 * Queue a response.create (tool follow-up, silence fallback, typed turn, refusal)
 * so it never races an active response.
 */
export function queueResponseCreate(gate, event, { filler = false } = {}) {
  const payload = event && event.type ? event : { type: "response.create" };
  gate.pendingCreates = [payload];
  gate.pendingFiller = Boolean(filler);
  return drain(gate);
}

/**
 * Language session.update must not land while audio is playing.
 * The salon demo never rewrites the session mid-reply; doing so cuts speech
 * and makes the next words sound confused. Flush once the response is idle.
 */
export function queueSessionUpdate(gate, event) {
  if (!event || event.type !== "session.update") return [];
  gate.pendingSession = event;
  return drain(gate);
}

function beginTool(gate, callId, name) {
  if (!callId || gate.seen.has(callId) || gate.tools.has(callId)) return false;
  if (gate.tools.size === 0) {
    gate.toolStartedAt = Date.now();
    gate.fillerUsed = false;
  }
  gate.seen.add(callId);
  if (gate.seen.size > 100) gate.seen.delete(gate.seen.values().next().value);
  gate.tools.set(callId, name || "tool");
  gate.turnNames.push(name || "tool");
  return true;
}

function responseHasSpeech(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const type = String(part?.type || "");
      if (type === "output_audio" || type === "audio" || type === "output_text") return true;
      if (String(part?.transcript || part?.text || "").trim()) return true;
    }
  }
  return false;
}

function responseHasTool(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.some((item) => item?.type === "function_call");
}

function drain(gate) {
  if (gate.active || gate.waitingForIdle) return [];
  // Speak before any session.update. A session.update in front of audio is a round trip of silence.
  if (gate.pendingCreates.length) {
    if (gate.tools.size > 0 && !gate.pendingFiller) return [];
    const event = gate.pendingCreates[0];
    gate.pendingCreates = [];
    gate.pendingFiller = false;
    gate.lastSent = event;
    gate.active = true;
    gate.waitingForIdle = false;
    return [event];
  }
  if (gate.tools.size > 0 || gate.holdSession) return [];
  if (!gate.pendingSession) return [];
  const session = gate.pendingSession;
  gate.pendingSession = null;
  return [session];
}

function settleResponse(gate, event, { suppressFallback = false } = {}) {
  if (event?.type === "response.created") {
    gate.active = true;
    gate.lastSent = null;
    gate.waitingForIdle = false;
    return [];
  }
  if (event?.type !== "response.done" && event?.type !== "response.cancelled") return [];
  const status = event.response?.status || (event.type === "response.cancelled" ? "cancelled" : "completed");
  const spoke = gate.heardAudio || responseHasSpeech(event.response);
  const hasTool = responseHasTool(event.response) || gate.tools.size > 0;
  gate.heardAudio = false;
  gate.active = false;
  gate.waitingForIdle = false;
  gate.holdSession = false;
  // Only a fully completed, silent, tool-less turn with clear caller speech
  // gets a spoken fallback. Noise / empty / short fragments must not inject
  // "didn't catch that" — wait silently. Cancelled/incomplete = barge-in.
  if (
    !suppressFallback
    && gate.fallbackArmed
    && status === "completed"
    && !spoke
    && !hasTool
    && gate.tools.size === 0
    && gate.pendingCreates.length === 0
  ) {
    gate.fallbackArmed = false;
    // Never dead air, never "please repeat": re-send the caller's reply once.
    if (gate.lastReply && !gate.replyRetried) {
      gate.replyRetried = true;
      gate.pendingCreates = [gate.lastReply];
      gate.pendingFiller = false;
    } else if (isWeatherTopic(gate.userText || "") && isClearLanguageTurn(gate.userText || "")) {
      // Still silent on a clear weather ask: say the lookup failed, not "repeat".
      gate.pendingCreates = [silenceFallbackEvent(gate.userText, gate.callerLanguage)];
      gate.pendingFiller = false;
    }
  }
  return drain(gate);
}

function noteResponseError(gate, message) {
  const text = String(message || "");
  const activeRace = /active response/i.test(text);
  if (activeRace) {
    if (gate.lastSent) {
      gate.pendingCreates = [gate.lastSent];
      gate.lastSent = null;
    }
    // Do not re-drain here — that loops create→error while the blocker is live.
    // Mark idle-wait; the next response.done / cancelled settles and drains.
    gate.active = false;
    gate.waitingForIdle = gate.pendingCreates.length > 0;
    return [];
  }
  // Harmless cancel-when-idle errors must not drop an in-flight create.
  if (/cancel/i.test(text) && /no active|nothing to cancel|not active/i.test(text)) {
    return [];
  }
  if (gate.lastSent) {
    gate.lastSent = null;
    gate.active = false;
    gate.waitingForIdle = false;
  }
  return [];
}

/** True when the reply spoken so far is already in `code`. Empty means unknown. */
export function replyInLanguage(text, code) {
  const t = String(text || "").trim();
  if (!t || !code) return false;
  if (code === "uk") return /[а-яіїєґ]/i.test(t) && !/[ыэъё]/i.test(t);
  if (code === "ru") return /[а-я]/i.test(t) && !/[іїєґ]/i.test(t);
  if (code === "he") return /[\u0590-\u05FF]/.test(t);
  if (code === "ar") return /[\u0600-\u06FF]/.test(t);
  return detectCallerLanguage(t) === code;
}

export function ingestRealtimeEvent(gate, event, { suppressFallback = false, now = Date.now() } = {}) {
  if (AUDIO_EVENT.has(event?.type)) gate.heardAudio = true;
  noteSpeechTiming(gate, event);
  let volume = "";
  if (event?.type === "response.created") {
    if (gate.replyText) gate.lastReplyText = gate.replyText;
    gate.replyText = "";
    gate.replyAudioAt = 0;
  }
  if ((event?.type === "response.output_audio_transcript.delta" || event?.type === "response.audio_transcript.delta") && event.delta) {
    gate.replyText = `${gate.replyText || ""}${event.delta}`;
  }
  // Playback state. WebRTC reports it (output_audio_buffer.*); the Twilio
  // bridge estimates it from the bytes it forwarded (setAgentPlayback).
  if (event?.type === "output_audio_buffer.started") setAgentPlayback(gate, true, now);
  if (event?.type === "output_audio_buffer.stopped" || event?.type === "output_audio_buffer.cleared") {
    setAgentPlayback(gate, false, now);
    if (gate.duck) { gate.duck = null; volume = "restore"; }
  }
  if ((event?.type === "response.output_audio.delta" || event?.type === "response.audio.delta") && !gate.replyAudioAt) {
    gate.replyAudioAt = now;
  }
  if (event?.type === "input_audio_buffer.speech_started") {
    volume = bargeSpeechStart(gate, event.item_id || "", now) || volume;
  }
  const toolCalls = [];
  for (const call of functionCallsFrom(event)) {
    if (beginTool(gate, call.callId, call.name)) toolCalls.push(call);
  }
  const send = event?.type === "error"
    ? noteResponseError(gate, event.error?.message || event.message || "")
    : settleResponse(gate, event, { suppressFallback });
  return { send, toolCalls, hold: shouldHoldForSpeech(gate), volume };
}

export function completeTool(gate, callId, epoch, ok) {
  if (!gate.tools.has(callId)) return [];
  gate.tools.delete(callId);
  if (ok) gate.turnOk = true;
  else gate.turnFailed = true;
  if (epoch != null && epoch !== gate.epoch) {
    if (gate.tools.size === 0) {
      disarmToolFiller(gate);
      gate.turnNames = [];
      gate.turnOk = false;
      gate.turnFailed = false;
    }
    return [];
  }
  if (gate.tools.size > 0) return [];
  const names = gate.turnNames.splice(0);
  const failed = gate.turnFailed && !gate.turnOk;
  gate.turnOk = false;
  gate.turnFailed = false;
  const label = names.find((name) => isWeatherTopic(name)) || names[0] || "";
  disarmToolFiller(gate);
  gate.fillerUsed = false;
  gate.toolStartedAt = 0;
  gate.toolRounds = (gate.toolRounds || 0) + 1;
  gate.pendingCreates = [toolFollowUpEvent(label, failed, gate.userText, gate.callerLanguage, {
    allowMore: gate.toolRounds < MAX_TOOL_ROUNDS,
  })];
  gate.pendingFiller = false;
  return drain(gate);
}

export function disarmToolFiller(gate) {
  if (gate.fillerTimer) clearTimeout(gate.fillerTimer);
  gate.fillerTimer = null;
}

function pumpToolFiller(gate, emit) {
  if (gate.fillerUsed || gate.tools.size === 0) return;
  if (!gate.toolStartedAt || Date.now() - gate.toolStartedAt < TOOL_FILLER_AFTER_MS) return;
  if (gate.active || gate.waitingForIdle || (gate.pendingCreates.length && !gate.pendingFiller)) {
    gate.fillerTimer = setTimeout(() => pumpToolFiller(gate, emit), 120);
    return;
  }
  gate.fillerUsed = true;
  const event = toolFillerEvent(gate.userText, gate.callerLanguage);
  for (const item of queueResponseCreate(gate, event, { filler: true })) emit(item);
}

/** One short still-looking line, only if the tool is still running after ~1.5s. */
export function armToolFiller(gate, emit) {
  if (gate.fillerUsed || gate.fillerTimer || gate.tools.size === 0) return;
  if (!gate.toolStartedAt) gate.toolStartedAt = Date.now();
  const wait = Math.max(0, TOOL_FILLER_AFTER_MS - (Date.now() - gate.toolStartedAt));
  gate.fillerTimer = setTimeout(() => {
    gate.fillerTimer = null;
    pumpToolFiller(gate, emit);
  }, wait);
}


/**
 * A response.create with its own `instructions` REPLACES the session
 * instructions for that response (OpenAI Realtime semantics). Until a85fa0f we
 * re-sent the whole ~1k-token prompt on every response to keep the Bot task
 * (01f8b7e); that also changed the very start of the prompt every time, so
 * nothing after it — ~12k tokens of tool schemas and the whole conversation —
 * could hit the prompt cache. That was most of the text-input bill.
 *
 * Now every response.create goes out WITHOUT instructions, so the stable
 * session instructions (Bot task included) apply and stay cached. The
 * per-reply nudge ("Reply ONLY in Ukrainian. Stay on: …") rides as a one-line
 * system item appended to the conversation just before it.
 */
export const REPLY_NOTE_PREFIX = "For this reply only:";
export function replyNoteItem(text) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
  };
}

export function toCachedResponse(event, { botTask = "" } = {}) {
  if (event?.type !== "response.create" || typeof event.response?.instructions !== "string") return [event];
  const { instructions, ...response } = event.response;
  let note = instructions.trim();
  const task = String(botTask || "").trim();
  if (task && note && !/Stay on:/.test(note) && !/^(The call just connected|Say exactly)/.test(note)) {
    note = `${note} Stay on: ${task}.`;
  }
  const out = [];
  if (note) out.push(replyNoteItem(`${REPLY_NOTE_PREFIX} ${note}`));
  out.push({ ...event, response });
  return out;
}

/** @deprecated kept for old callers: returns the last event of toCachedResponse. */
export function withSessionInstructions(event) {
  const events = toCachedResponse(event);
  return events[events.length - 1];
}

/**
 * Sent once, right after the greeting finishes. Without it the English
 * "Hello" greeting in the conversation anchored the model's first auto-reply to
 * English (live call_14, Oct 20; probe 0/5 Ukrainian without it, 5/5 with it).
 */
export const GREETING_LANGUAGE_NOTE = "That greeting was a fixed opening line, not the caller's language. Reply in the language the caller speaks.";
export function greetingLanguageNote() {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: GREETING_LANGUAGE_NOTE }],
    },
  };
}


/** Caller speech shorter than this never interrupts the agent (cough, click, "mm"). */
export const BARGE_IN_MIN_MS = 400;
/** Place search -> forecast needs two lookups; cap the chain. */
export const MAX_TOOL_ROUNDS = 3;

function noteSpeechTiming(gate, event) {
  if (!gate.speechStart) gate.speechStart = new Map();
  if (!gate.speechMs) gate.speechMs = new Map();
  const id = event?.item_id;
  if (!id) return;
  if (event.type === "input_audio_buffer.speech_started") {
    gate.speechStart.set(id, Number(event.audio_start_ms) || 0);
  } else if (event.type === "input_audio_buffer.speech_stopped") {
    const start = gate.speechStart.get(id);
    if (start != null) gate.speechMs.set(id, Math.max(0, (Number(event.audio_end_ms) || 0) - start));
    gate.speechStart.delete(id);
  }
  if (gate.speechMs.size > 50) gate.speechMs.delete(gate.speechMs.keys().next().value);
}

/** The reply to one caller turn; toCachedResponse adds "Stay on: <Bot task>". */
export function callerReplyEvent(text, code, { partial = false } = {}) {
  // A partial transcript only fixes the language; the model hears the full audio.
  const line = shortLanguageLine(code, partial ? "" : text);
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "auto",
      instructions: `${line} Answer their latest turn in one or two short sentences; don't ask them to repeat.`,
    },
  };
}

/**
 * Early start: the transcript streams in deltas. As soon as the partial text is
 * clearly real speech in a known language, answer without waiting for the
 * final transcript (saves the tail of transcription). The final transcript for
 * the same item is then only recorded, not answered again.
 */
export function handleCallerPartial(gate, partialText, { itemId = "" } = {}) {
  if (!itemId) return null;
  if (!gate.answeredItems) gate.answeredItems = new Set();
  if (gate.answeredItems.has(itemId)) return null;
  const clean = String(partialText || "").replace(/\s+/g, " ").trim();
  if (classifyCallerTranscript(clean) !== "speech" || !isClearLanguageTurn(clean)) return null;
  // While the agent talks, a partial only stops it once it is confirmed speech.
  if (agentSpeaking(gate) && interruptionVerdict(clean, agentHeardText(gate)) !== "interrupt") return null;
  const result = handleCallerTurn(gate, clean, { itemId, partial: true });
  if (result.kind === "speech") gate.answeredItems.add(itemId);
  return result;
}

/**
 * Structural turn-taking. The session runs with create_response=false and
 * interrupt_response=false, so the model never answers raw audio on its own.
 * Each finished caller transcript lands here:
 *  - noise (empty, punctuation, filler, known hallucination) -> ignored, and
 *    the item is dropped from the conversation;
 *  - real speech -> language from the transcript, then one response.create
 *    whose instructions say "Reply ONLY in <language>".
 * Real speech of at least BARGE_IN_MIN_MS while the agent talks cancels it
 * (`cancel: true`: the caller sends response.cancel and clears playback).
 */
export function handleCallerTurn(gate, text, { itemId = "", partial = false } = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!partial && itemId && gate.answeredItems?.has(itemId)) {
    // Already answered from the streaming transcript; keep the full words for tool follow-ups.
    gate.answeredItems.delete(itemId);
    if (classifyCallerTranscript(clean) === "speech") gate.userText = clean;
    return { kind: "answered", send: [], cancel: false, language: gate.callerLanguage || "", deleteItem: false };
  }
  const speaking = agentSpeaking(gate);
  const ignore = (kind, reason) => {
    const restore = Boolean(gate.duck);
    gate.duck = null;
    return { kind, reason, send: [], cancel: false, language: gate.callerLanguage || "", deleteItem: Boolean(itemId), volume: restore ? "restore" : "" };
  };
  if (classifyCallerTranscript(clean) === "noise") return ignore("noise", "noise");
  const speechMs = itemId && gate.speechMs ? gate.speechMs.get(itemId) : undefined;
  if (speaking) {
    // The agent is talking: only confirmed interrupting speech stops it.
    // Coughs, "ага", TV words and its own voice through the speakers do not.
    if (speechMs != null && speechMs < BARGE_IN_MIN_MS) return ignore("short", "short");
    const verdict = interruptionVerdict(clean, agentHeardText(gate));
    if (verdict !== "interrupt") return ignore(verdict === "noise" ? "noise" : "ignored", verdict);
  } else if (gate.playEndedAt && Date.now() - gate.playEndedAt < ECHO_TAIL_MS && isEchoOf(clean, agentHeardText(gate))) {
    // The tail of the agent's own reply, picked up after playback ended.
    return ignore("noise", "echo");
  }
  const detected = detectCallerLanguage(clean);
  noteCallerSpeech(gate, clean);
  gate.userText = clean;
  const language = gate.callerLanguage || detected || "";
  const reply = callerReplyEvent(clean, language, { partial });
  gate.lastReply = reply;
  gate.replyRetried = false;
  gate.toolRounds = 0;
  gate.fallbackArmed = true;
  const interrupt = gate.active;
  const stopPlayback = speaking;
  gate.duck = null;
  if (gate.active || gate.tools.size > 0 || gate.waitingForIdle) {
    // A real new turn supersedes the reply in flight and any tool wait.
    gate.epoch += 1;
    gate.tools.clear();
    disarmToolFiller(gate);
    gate.turnNames = [];
    gate.turnOk = false;
    gate.turnFailed = false;
    gate.lastSent = null;
    gate.fillerUsed = false;
    gate.toolStartedAt = 0;
  }
  gate.pendingCreates = [reply];
  gate.pendingFiller = false;
  if (interrupt) return { kind: "speech", send: [], cancel: true, language, deleteItem: false, volume: "restore" };
  gate.waitingForIdle = false;
  if (stopPlayback) {
    // Response already done but its audio is still playing: clear it, answer now.
    gate.playing = false;
    return { kind: "speech", send: drain(gate), cancel: true, language, deleteItem: false, volume: "restore" };
  }
  return { kind: "speech", send: drain(gate), cancel: false, language, deleteItem: false, volume: "" };
}

/** Errors from our own cancel/clear/delete racing the server: never user-facing. */
export function isBenignRealtimeError(message = "", code = "") {
  return /active response|no active response|response_cancel_not_active|not found|item_id|output_audio_buffer|nothing to cancel|buffer too small|input_audio_buffer_commit_empty/i
    .test(`${code} ${message}`);
}

/**
 * Cost guard: a Realtime session bills while it is open and every response
 * re-reads the prompt. End the call after SILENCE_HANGUP_MS without real
 * speech from either side (noise does not count), and always at MAX_CALL_MS.
 */
export const SILENCE_HANGUP_MS = 30_000;
export const MAX_CALL_MS = 10 * 60_000;
export function createCallBudget({ now = () => Date.now(), silenceMs = SILENCE_HANGUP_MS, maxMs = MAX_CALL_MS } = {}) {
  const startedAt = now();
  let lastActivity = startedAt;
  return {
    startedAt,
    noteActivity() { lastActivity = now(); },
    /** "max" | "silence" | "" — `busy` (agent speaking, tool running) holds the silence timer. */
    check(busy = false) {
      const t = now();
      if (t - startedAt >= maxMs) return "max";
      if (busy) { lastActivity = t; return ""; }
      return t - lastActivity >= silenceMs ? "silence" : "";
    },
  };
}

export function budgetEndMessage(reason) {
  if (reason === "max") return "Call ended: the 10-minute limit for a voice call was reached.";
  if (reason === "silence") return "Call ended after 30 seconds of silence.";
  return "";
}


/* ------------------------------------------------------------------------ *
 * Barge-in: duck first, stop only on confirmed speech.
 *
 * Any sound while the agent talks only lowers its volume (DUCK_VOLUME). The
 * agent stops only when the caller's transcript is real interrupting speech:
 * >= 2 real words or >= 6 letters (or an explicit "stop"), not a filler or
 * backchannel ("ага", "угу", "так", "mm", "ok", "yeah", "sí"), not a known
 * transcription hallucination, and not an echo of the agent's own words.
 * Nothing confirmed within DUCK_CONFIRM_MS -> volume restored, reply goes on.
 * ------------------------------------------------------------------------ */
export const DUCK_VOLUME = 0.3;
export const DUCK_CONFIRM_MS = 1200;
/** Sound in the first moments of each reply is mostly the reply's own echo. */
export const ECHO_GUARD_MS = 400;
/** After playback ends, a transcript of the agent's own last words is echo. */
export const ECHO_TAIL_MS = 2500;

const BACKCHANNEL = new Set([
  "ага", "угу", "так", "аха", "ага-ага", "ну", "да", "ок", "окей", "добре", "ясно", "зрозуміло", "понятно", "хорошо", "звісно", "авжеж", "ладно",
  "mm", "mmm", "mhm", "mm-hmm", "mmhmm", "uh-huh", "uhhuh", "aha", "ok", "okay", "yeah", "yes", "yep", "yup", "right", "sure", "cool", "nice", "alright",
  "sí", "si", "vale", "claro", "ya", "bueno", "oui", "ja", "d'accord",
]);
const STOP_WORDS = /^(?:стоп|стій|стоп-стоп|зачекай(?:те)?|почекай(?:те)?|підожди|подожди|погоди|хвилинку|секунду|stop|wait|hold|espera|para|un momento|attends|halt)$/iu;
const FILLER_WORD = /^(?:u+h+|u+m+|h+m+|m+h*m*|a+h+|e+h+|o+h+|е+|э+|м+|а+|ее+|эм+|хм+|ммм+|ой|ах)$/iu;

function hasVowel(word) {
  if (!/[a-zа-яіїєґё]/i.test(word)) return true; // other scripts: no vowel rule
  return /[aeiouyáéíóúüàèòâêôаеєиіїоуюяыэё]/i.test(word);
}

function plainWords(text) {
  return String(text || "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter(Boolean);
}

function stemMatch(word, agentSet, agentStems) {
  if (agentSet.has(word)) return true;
  return word.length >= 5 && agentStems.has(word.slice(0, 5));
}

/** True when most of the caller's words are words the agent is (just) saying. */
export function isEchoOf(text, agentText) {
  const caller = plainWords(text).filter((w) => (w.match(/\p{L}/gu) || []).length >= 2);
  const agent = plainWords(agentText);
  if (!caller.length || !agent.length) return false;
  const set = new Set(agent);
  const stems = new Set(agent.filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
  const hit = caller.filter((w) => stemMatch(w, set, stems)).length;
  return hit / caller.length >= 0.6;
}

/** "interrupt" | "noise" | "backchannel" | "echo" | "short" for speech heard while the agent talks. */
export function interruptionVerdict(text, agentText = "") {
  const clean = String(text || "").replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").trim();
  if (classifyCallerTranscript(clean) === "noise") return "noise";
  const words = plainWords(clean);
  if (!words.length) return "noise";
  if (isEchoOf(clean, agentText)) return "echo";
  if (words.some((w) => STOP_WORDS.test(w)) || /\b(?:hold on|un momento|wait a (?:second|moment))\b/i.test(clean)) return "interrupt";
  // A real word has a vowel ("кх", "хм", "pff" are coughs and clicks).
  const real = words.filter((w) => !BACKCHANNEL.has(w) && !FILLER_WORD.test(w) && hasVowel(w));
  if (!real.length) return "backchannel";
  const letters = real.join("").match(/\p{L}/gu)?.length || 0;
  if (real.length >= 2 || letters >= 6) return "interrupt";
  return "short";
}

export function agentSpeaking(gate) {
  return Boolean(gate.active || gate.playing);
}

function agentHeardText(gate) {
  return `${gate.replyText || ""} ${gate.lastReplyText || ""}`.trim();
}

export function setAgentPlayback(gate, playing, now = Date.now()) {
  if (playing) {
    if (!gate.playing && !gate.replyAudioAt) gate.replyAudioAt = now;
    gate.playing = true;
    return;
  }
  if (gate.playing) gate.playEndedAt = now;
  gate.playing = false;
  if (gate.replyText) gate.lastReplyText = gate.replyText;
}

/** Caller sound started. Returns "duck" when the agent should get quieter. */
export function bargeSpeechStart(gate, itemId = "", now = Date.now()) {
  if (!agentSpeaking(gate)) return "";
  if (gate.replyAudioAt && now - gate.replyAudioAt < ECHO_GUARD_MS) return "";
  const already = Boolean(gate.duck);
  gate.duck = { itemId, at: now };
  return already ? "" : "duck";
}

/** Call every ~200 ms. Returns "restore" when an unconfirmed duck times out. */
export function bargeTick(gate, now = Date.now()) {
  if (!gate.duck) return "";
  if (!agentSpeaking(gate) || now - gate.duck.at >= DUCK_CONFIRM_MS) {
    gate.duck = null;
    return "restore";
  }
  return "";
}
