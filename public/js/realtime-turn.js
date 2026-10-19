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

import { callerTurnLine, isClearLanguageTurn, resolveReplyLanguage, spokenFailure, languageName } from "./caller-language.js";

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
  if (changed && gate.active && gate.tools.size === 0 && gate.pendingCreates.length === 0) {
    out.restart = true;
    gate.pendingCreates = [languageRestartEvent(gate.userText, language)];
    gate.pendingFiller = false;
    gate.fallbackArmed = false;
  }
  return out;
}

function languageRestartEvent(userText, established) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "auto",
      instructions: [
        callerTurnLine(userText, established),
        "The caller already spoke this turn. Answer now in that language.",
        "English Bot task text, an English greeting, Model notes, or tool JSON must not make you answer in English.",
      ].join(" "),
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
        instructions: `${callerTurnLine(userText, code)} ${instructions}`.trim(),
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

export function toolFollowUpEvent(name, failed, userText = "", established = "") {
  const line = spokenFailure(name, userText, established);
  const turn = callerTurnLine(userText, established);
  const instructions = failed
    ? `${turn} The tool failed, timed out, or is missing. Say this in the caller's language, then stop: ${line} Do not invent a result. Do not call tools.`
    : `${turn} Speak the tool result to the caller in their language. One to two short sentences. Use only facts from the tool result. The tool payload may be English or include a place name such as Castellón. That is not a language switch. If it includes current conditions, speak the temperature and condition. An airport or aerodrome of the city the caller named is the right place: say the weather and do not ask them to clarify. Ask for a different place only when the result says the match is a different city. If the result is an error, say you can't get that right now and do not invent data. Do not call tools.`;
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "none",
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
      instructions: `Say exactly this, in ${name}, then stop: ${line} Do not give the result. Do not invent weather, prices, or appointments. Do not call tools.`,
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
      instructions: `${callerTurnLine(userText, code)} You produced no speech. Say this in the caller's language, then stop: ${line} Do not invent weather, records, or tool results. Do not call tools.`,
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
    if (isClearLanguageTurn(gate.userText || "")) {
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

export function ingestRealtimeEvent(gate, event, { suppressFallback = false } = {}) {
  if (AUDIO_EVENT.has(event?.type)) gate.heardAudio = true;
  const toolCalls = [];
  for (const call of functionCallsFrom(event)) {
    if (beginTool(gate, call.callId, call.name)) toolCalls.push(call);
  }
  const send = event?.type === "error"
    ? noteResponseError(gate, event.error?.message || event.message || "")
    : settleResponse(gate, event, { suppressFallback });
  return { send, toolCalls, hold: shouldHoldForSpeech(gate) };
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
  gate.pendingCreates = [toolFollowUpEvent(label, failed, gate.userText, gate.callerLanguage)];
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
 * instructions for that response (OpenAI Realtime semantics). Our per-reply
 * nudges (language restart, tool follow-up, filler, refusal) carried only a
 * language line, so the model answered with no Bot task at all — the live
 * Oct 19 "I can help with texts, images, recipes…" pitch on the Weather agent.
 * Every per-reply instruction now rides on top of the full session instructions.
 */
export const REPLY_SCOPE_MARKER = "For this reply only:";
export function withSessionInstructions(event, base) {
  const extra = event?.type === "response.create" ? event.response?.instructions : undefined;
  const full = String(base || "").trim();
  if (typeof extra !== "string" || !full || extra.includes(REPLY_SCOPE_MARKER) || extra.startsWith(full)) return event;
  return {
    ...event,
    response: { ...event.response, instructions: `${full}\n\n${REPLY_SCOPE_MARKER} ${extra}` },
  };
}
