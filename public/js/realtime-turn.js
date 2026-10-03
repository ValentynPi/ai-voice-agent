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

export const TOOL_TURN_TIMEOUT_MS = 10000;
export const TOOL_FETCH_TIMEOUT_MS = 15000;

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
    lastSent: null,
    /** True when a create was rejected as "active response" and is waiting for idle. */
    waitingForIdle: false,
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
  const clean = String(text || "").trim();
  if (clean) gate.userText = clean;
}

/**
 * Real barge-in only while a response is active (model speaking / streaming).
 * Speech during a tool wait must NOT bump the epoch or clear the queued
 * spoken follow-up — that was dropping replies and leaving both dialers silent.
 * Returns true when the barge-in invalidated an in-flight turn.
 */
export function noteBargeIn(gate) {
  gate.fallbackArmed = true;
  if (!gate.active) {
    // Idle or waiting on MCP: keep queued follow-ups and the tool epoch.
    // If a create is stuck behind a phantom "active response" race, drop it —
    // semantic VAD create_response will answer this new caller turn.
    if (gate.waitingForIdle) {
      gate.pendingCreates = [];
      gate.waitingForIdle = false;
      gate.lastSent = null;
    }
    return false;
  }
  gate.epoch += 1;
  gate.pendingCreates = [];
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

export function toolFollowUpEvent(name, failed, userText = "") {
  const line = failureLine(name, userText);
  const instructions = failed
    ? `The tool failed, timed out, or is missing. Say this in the caller's language, then stop: ${line} Do not invent a result. Do not call tools.`
    : "Speak the tool result to the caller in their language. One to three short sentences. Use only facts from the tool result. If it includes current conditions, speak the temperature and condition. An airport or aerodrome of the city the caller named is the right place: say the weather and do not ask them to clarify. Ask for a different place only when the result says the match is a different city. If the result is an error, say you can't get that right now and do not invent data. Do not call tools.";
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "none",
      instructions,
    },
  };
}

export function silenceFallbackEvent(userText) {
  const line = isWeatherTopic(userText)
    ? "I can't get the weather right now."
    : "Sorry, I didn't catch that. Could you say it again?";
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tool_choice: "none",
      instructions: `You produced no speech. Say this in the caller's language, then stop: ${line} Do not invent weather, records, or tool results. Do not call tools.`,
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
export function queueResponseCreate(gate, event) {
  const payload = event && event.type ? event : { type: "response.create" };
  gate.pendingCreates = [payload];
  return drain(gate);
}

function beginTool(gate, callId, name) {
  if (!callId || gate.seen.has(callId) || gate.tools.has(callId)) return false;
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
  if (gate.active || gate.pendingCreates.length === 0 || gate.tools.size > 0) return [];
  const event = gate.pendingCreates[0];
  gate.pendingCreates = [];
  gate.lastSent = event;
  gate.active = true;
  gate.waitingForIdle = false;
  return [event];
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
  // Only a fully completed, silent, tool-less turn gets a spoken fallback.
  // Cancelled/incomplete means barge-in or interrupt — never inject a create
  // that would race the caller's next audio (cuts mid-reply / drops understanding).
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
    gate.pendingCreates = [silenceFallbackEvent(gate.userText)];
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
  gate.pendingCreates = [toolFollowUpEvent(label, failed, gate.userText)];
  return drain(gate);
}
