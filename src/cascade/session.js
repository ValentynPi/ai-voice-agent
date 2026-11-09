/**
 * Cascade call session, transport-agnostic (browser WebSocket or Twilio).
 *
 *   caller audio -> STT partials/commits -> turn gate (noise, backchannel,
 *   echo, barge-in) -> OpenAI text model (streamed, MCP tools, <= 3 rounds)
 *   -> sentences -> TTS stream -> paced audio out.
 *
 * Turn-taking reuses the Realtime rules from public/js/realtime-turn.js and
 * backchannel.js, so "yeah" / "ага" / "угу" keep the agent talking and only
 * confirmed speech ("стоп", or a real question) stops it.
 */
import { DEFAULT_GREETING } from "../defaults.js";
import {
  classifyCallerTranscript,
  detectCallerLanguage,
  isClearLanguageTurn,
} from "../../public/js/caller-language.js";
import { isBackchannel, transcriptTokens } from "../../public/js/backchannel.js";
import {
  DUCK_CONFIRM_MS,
  DUCK_VOLUME,
  ECHO_GUARD_MS,
  ECHO_TAIL_MS,
  MAX_TOOL_ROUNDS,
  TOOL_FETCH_TIMEOUT_MS,
  TOOL_FILLER_AFTER_MS,
  createCallBudget,
  failureLine,
  interruptionVerdict,
  isEchoOf,
  shortLanguageLine,
  stillLookingLine,
  withTimeout,
} from "../../public/js/realtime-turn.js";
import { spokenFailure } from "../../public/js/caller-language.js";
import { scaleMulawBase64 } from "../twilio/mulaw.js";
import { takeSentences } from "./llm.js";

/** Audio kept queued ahead of real time, so clear/duck act on what the caller hears. */
export const CASCADE_AUDIO_LEAD_MS = 500;
/** Recent turns sent to the model (user + assistant messages). */
export const CASCADE_HISTORY_MESSAGES = 12;
export const CASCADE_MAX_TOKENS = 300;

export const CASCADE_VOICE_RULES = [
  "VOICE OUTPUT: your text is read aloud by a native text-to-speech voice of the reply language. Write plain spoken sentences only in that language and its own script (Ukrainian in Ukrainian Cyrillic, Hebrew in Hebrew letters).",
  "Write numbers, temperatures, units, times and dates as words of that language (\"двадцять градусів\", \"עשרים מעלות\", \"twenty degrees\"); never digits, symbols such as ° % km/h, abbreviations, markdown, lists, or emojis. One or two short sentences.",
].join("\n");

const MISSED = {
  uk: "Вибачте, я не розчув. Повторіть, будь ласка.",
  es: "Perdona, no te he oído. ¿Puedes repetirlo?",
  en: "Sorry, I didn't catch that. Could you say it again?",
  ru: "Извините, я не расслышал. Повторите, пожалуйста.",
  fr: "Pardon, je n'ai pas compris. Pouvez-vous répéter ?",
  he: "סליחה, לא שמעתי. אפשר לחזור על זה?",
};

export function bytesToMs(format, bytes) {
  return format === "mulaw8k" ? bytes / 8 : bytes / 32;
}

/**
 * Reply language for a committed caller turn. The transcript's own letters
 * and words win (they separate Ukrainian from Russian best); otherwise the
 * STT language for a turn of 2+ words; otherwise keep the call's language.
 */
export function pickReplyLanguage(established, text, sttLanguage = "") {
  const fromText = detectCallerLanguage(text);
  if (fromText && isClearLanguageTurn(text)) return fromText;
  const words = transcriptTokens(text).filter((w) => /\p{L}{2,}/u.test(w)).length;
  if (sttLanguage && words >= 2) {
    if (sttLanguage === "ru" && fromText === "uk") return "uk";
    return sttLanguage;
  }
  return established || fromText || sttLanguage || "";
}

function greetingText(agent) {
  if (!agent) return DEFAULT_GREETING;
  return String(agent.greeting || agent.greetingEn || agent.greetingEs || "").trim() || DEFAULT_GREETING;
}

function greetingLanguage(agent, line) {
  const detected = detectCallerLanguage(line);
  if (detected) return detected;
  if (/[\u0590-\u05FF]/.test(line)) return "he";
  if (agent?.language === "es" || agent?.language === "en") return agent.language;
  return /^[\x00-\x7F\s]+$/.test(line) ? "en" : "";
}

export function createCascadeSession({
  callId,
  agent = null,
  format = "pcm16k",
  instructions = "",
  botTask = "",
  tools = [],
  openStt,
  openTts,
  llm,
  runTool,
  record = () => ({ blocked: false }),
  output,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (line) => console.info(line),
  budget = createCallBudget({ now }),
} = {}) {
  const out = {
    audio: () => {}, clear: () => {}, volume: () => {}, event: () => {}, end: () => {},
    ...(output || {}),
  };
  const state = {
    closed: false,
    greetingDone: false,
    callerLanguage: "",
    history: [],
    replySeq: 0,
    reply: null,
    queue: [],
    carry: null,
    playEndsAt: 0,
    playEndedAt: 0,
    replyAudioAt: 0,
    duck: null,
    heardOverSpeech: false,
    lastAgentText: "",
    stt: null,
  };
  const trace = (kind, detail = "") => log(`call-trace ${callId || "cascade"} cascade ${kind}${detail ? ` ${String(detail).slice(0, 80)}` : ""}`);

  const playing = (t = now()) => state.queue.length > 0 || t < state.playEndsAt;
  const speaking = (t = now()) => Boolean(state.reply?.generating) || playing(t);
  const heardText = () => `${state.reply?.text || ""} ${state.lastAgentText || ""}`.trim();

  function restoreVolume(why = "") {
    if (!state.duck) return;
    state.duck = null;
    out.volume(1);
    trace("restore", why);
  }

  function duck(t) {
    if (!speaking(t)) return;
    if (state.replyAudioAt && t - state.replyAudioAt < ECHO_GUARD_MS) return;
    if (state.duck) { state.duck.at = t; return; }
    state.duck = { at: t };
    out.volume(DUCK_VOLUME);
    trace("duck");
  }

  function chunkSize() {
    return format === "mulaw8k" ? 800 : 3200; // 100 ms
  }

  function enqueue(buffer, replyId) {
    if (state.closed || !state.reply || state.reply.id !== replyId || !buffer?.length) return;
    let buf = Buffer.from(buffer);
    if (format !== "mulaw8k") {
      // PCM16: keep sample alignment across provider chunks.
      if (state.carry) { buf = Buffer.concat([state.carry, buf]); state.carry = null; }
      if (buf.length % 2) { state.carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
    }
    const size = chunkSize();
    for (let i = 0; i < buf.length; i += size) state.queue.push({ id: replyId, data: buf.subarray(i, i + size) });
    budget.noteActivity();
    pump();
  }

  function pump(t = now()) {
    while (state.queue.length && state.playEndsAt - t < CASCADE_AUDIO_LEAD_MS) {
      const chunk = state.queue.shift();
      let data = chunk.data;
      if (state.duck && format === "mulaw8k") data = Buffer.from(scaleMulawBase64(data.toString("base64"), DUCK_VOLUME), "base64");
      if (!state.replyAudioAt) {
        state.replyAudioAt = t;
        out.event({ type: "phase", state: "speaking" });
      }
      out.audio(data);
      state.playEndsAt = Math.max(t, state.playEndsAt) + bytesToMs(format, chunk.data.length);
    }
    if (!state.queue.length && state.playEndsAt && t >= state.playEndsAt && !state.reply?.generating && state.replyAudioAt) {
      state.playEndedAt = state.playEndsAt;
      state.playEndsAt = 0;
      state.replyAudioAt = 0;
      if (state.reply?.text) state.lastAgentText = state.reply.text;
      restoreVolume("ended");
      out.event({ type: "phase", state: "listening" });
    }
  }

  /** Stop the reply in flight (barge-in, new turn, hang-up). */
  function stopReply(why = "") {
    const current = state.reply;
    if (!current) return;
    state.reply = null;
    current.cancelled = true;
    try { current.abort.abort(); } catch { /* ignore */ }
    try { current.tts?.abort(); } catch { /* ignore */ }
    if (current.fillerTimer) clearTimer(current.fillerTimer);
    const hadAudio = state.queue.length > 0 || now() < state.playEndsAt;
    state.queue = [];
    state.carry = null;
    if (hadAudio) state.playEndedAt = now();
    state.playEndsAt = 0;
    state.replyAudioAt = 0;
    if (current.text) state.lastAgentText = current.text;
    if (current.generating && current.text && !current.recorded) {
      current.recorded = true;
      safeRecord("assistant", current.text);
    }
    if (hadAudio || why) out.clear();
    restoreVolume(why || "stop");
  }

  function safeRecord(role, text) {
    try {
      return record({ callId, role, text, lang: state.callerLanguage || "" }) || {};
    } catch (error) {
      trace("record-failed", error?.message || "");
      return {};
    }
  }

  function fail(error) {
    if (state.closed) return;
    const code = String(error?.code || "cascade_error");
    trace("error", code);
    out.event({ type: "error", code, message: String(error?.message || "Voice failed").slice(0, 200) });
    close("failed");
  }

  function newReply(language) {
    stopReply();
    const id = ++state.replySeq;
    const reply = { id, language, text: "", generating: true, abort: new AbortController(), tts: null, fillerUsed: false };
    reply.tts = openTts({ language, format, onAudio: (buf) => enqueue(buf, id) });
    state.reply = reply;
    state.replyAudioAt = 0;
    return reply;
  }

  function speak(reply, sentence) {
    const clean = String(sentence || "").trim();
    if (!clean || reply.cancelled) return;
    reply.text = reply.text ? `${reply.text} ${clean}` : clean;
    reply.tts.send(clean);
  }

  async function finishReply(reply, { recordText = true } = {}) {
    reply.tts.end();
    try {
      await reply.tts.done;
    } catch (error) {
      if (!reply.cancelled) fail(error);
      return;
    }
    if (reply.cancelled || state.reply !== reply) return;
    reply.generating = false;
    if (recordText && reply.text && !reply.recorded) {
      reply.recorded = true;
      safeRecord("assistant", reply.text);
    }
    if (reply.text) out.event({ type: "transcript", role: "assistant", text: reply.text });
    pump();
  }

  /** A fixed line (greeting, refusal): no model call. */
  async function speakFixed(line, language, { recordText = true, history = false } = {}) {
    const reply = newReply(language);
    speak(reply, line);
    await finishReply(reply, { recordText });
    if (history && reply.text && !reply.cancelled) pushHistory("assistant", reply.text);
  }

  function pushHistory(role, content) {
    state.history.push({ role, content });
    if (state.history.length > CASCADE_HISTORY_MESSAGES) state.history.splice(0, state.history.length - CASCADE_HISTORY_MESSAGES);
  }

  function replyNote(language, text) {
    const task = String(botTask || "").trim();
    return `For this reply only: ${shortLanguageLine(language, text)}${task ? ` Stay on: ${task}.` : ""}`;
  }

  async function runOneTool(call) {
    let args = {};
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
    try {
      const outcome = await withTimeout(
        Promise.resolve(runTool({ callId, name: call.name, args })),
        TOOL_FETCH_TIMEOUT_MS,
        () => ({ ok: false, result: { error: failureLine(call.name) } }),
      );
      return outcome?.ok ? (outcome.result ?? {}) : { error: outcome?.result?.error || failureLine(call.name) };
    } catch {
      return { error: failureLine(call.name) };
    }
  }

  async function answer(userText, language) {
    const reply = newReply(language);
    out.event({ type: "phase", state: "thinking" });
    const messages = [
      { role: "system", content: instructions },
      ...state.history,
      { role: "user", content: userText },
      { role: "system", content: replyNote(language, userText) },
    ];
    pushHistory("user", userText);
    let buffer = "";
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const allowTools = tools.length > 0 && round < MAX_TOOL_ROUNDS;
        let calls = null;
        let roundText = "";
        for await (const event of llm({ messages, tools: allowTools ? tools : [], toolChoice: allowTools ? "auto" : "none", signal: reply.abort.signal, maxTokens: CASCADE_MAX_TOKENS, cacheKey: agent?.id || "" })) {
          if (reply.cancelled) return;
          if (event.type === "text" && event.delta) {
            buffer += event.delta;
            roundText += event.delta;
            const { sentences, rest } = takeSentences(buffer, { first: !reply.text });
            for (const sentence of sentences) speak(reply, sentence);
            buffer = rest;
          } else if (event.type === "tool_calls") {
            calls = event.calls;
          }
        }
        if (reply.cancelled) return;
        if (!calls?.length) break;
        if (buffer.trim()) { speak(reply, buffer); buffer = ""; }
        messages.push({
          role: "assistant",
          content: roundText || null,
          tool_calls: calls.map((c, i) => ({ id: c.id || `call_${round}_${i}`, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
        });
        if (!reply.fillerUsed && !reply.text) {
          reply.fillerTimer = setTimer(() => {
            reply.fillerTimer = null;
            if (reply.cancelled || reply.fillerUsed || reply.text) return;
            reply.fillerUsed = true;
            trace("filler");
            speak(reply, stillLookingLine(language));
          }, TOOL_FILLER_AFTER_MS);
        }
        trace("tools", calls.map((c) => c.name).join(","));
        const results = await Promise.all(calls.map(runOneTool));
        if (reply.fillerTimer) { clearTimer(reply.fillerTimer); reply.fillerTimer = null; }
        if (reply.cancelled) return;
        calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id || `call_${round}_${i}`, content: JSON.stringify(results[i]) }));
      }
      if (buffer.trim()) speak(reply, buffer);
    } catch (error) {
      if (reply.cancelled || error?.name === "AbortError") return;
      if (/^openai_(key|quota)/.test(String(error?.code || ""))) { fail(error); return; }
      trace("llm-error", error?.code || error?.message || "");
      speak(reply, spokenFailure("", userText, language));
    }
    // Never dead air: an empty answer becomes one short "didn't catch that".
    if (!reply.text.trim()) speak(reply, MISSED[language] || MISSED.en);
    await finishReply(reply);
    if (!reply.cancelled && reply.text) pushHistory("assistant", reply.text);
  }

  function onPartial(text) {
    if (state.closed) return;
    const t = now();
    out.event({ type: "interim", text: String(text).slice(0, 300) });
    if (!speaking(t)) return;
    // Any caller sound only ducks the agent; interruptionVerdict decides about stopping.
    if (!/\p{L}/u.test(String(text))) return;
    state.heardOverSpeech = true;
    duck(t);
    if (state.replyAudioAt && t - state.replyAudioAt < ECHO_GUARD_MS) return;
    if (interruptionVerdict(text, heardText()) === "interrupt") {
      trace("interrupt", "partial");
      stopReply("interrupt");
    }
  }

  function onCommitted(text, sttLanguage = "") {
    if (state.closed) return;
    const t = now();
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    const overSpeech = state.heardOverSpeech;
    state.heardOverSpeech = false;
    if (classifyCallerTranscript(clean) === "noise") { restoreVolume("noise"); trace("drop-noise"); return; }
    if (speaking(t)) {
      if (isBackchannel(clean)) { restoreVolume("backchannel"); trace("drop-backchannel"); return; }
      const verdict = interruptionVerdict(clean, heardText());
      if (verdict !== "interrupt") { restoreVolume(verdict); trace(`drop-${verdict}`); return; }
      trace("interrupt");
      stopReply("interrupt");
    } else if (state.playEndedAt && t - state.playEndedAt < ECHO_TAIL_MS && isEchoOf(clean, state.lastAgentText)) {
      trace("drop-echo");
      return;
    } else if (overSpeech && isBackchannel(clean)) {
      // "ага" said over the agent's last words, committed just after it stopped.
      trace("drop-backchannel", "tail");
      return;
    }
    if (!state.greetingDone) state.greetingDone = true;
    const language = pickReplyLanguage(state.callerLanguage, clean, sttLanguage);
    if (language) state.callerLanguage = language;
    budget.noteActivity();
    out.event({ type: "transcript", role: "user", text: clean, language });
    const outcome = safeRecord("user", clean);
    if (outcome.blocked) {
      void speakFixed(outcome.reply, language, { recordText: false });
      return;
    }
    void answer(clean, language);
  }

  async function start() {
    const stt = openStt({ format, onPartial, onCommitted, onError: fail });
    state.stt = stt;
    try {
      await stt.ready;
    } catch (error) {
      fail(error);
      return false;
    }
    if (state.closed) return false;
    out.event({ type: "ready" });
    const line = greetingText(agent);
    const language = greetingLanguage(agent, line);
    await speakFixed(line, language);
    state.greetingDone = true;
    return true;
  }

  function pushAudio(buffer) {
    if (state.closed || !state.stt) return;
    state.stt.send(buffer);
  }

  /** Call every ~50 ms: pacing, duck timeout, cost guard. */
  function tick(t = now()) {
    if (state.closed) return;
    pump(t);
    if (state.duck && (t - state.duck.at >= DUCK_CONFIRM_MS || !speaking(t))) restoreVolume("timeout");
    const busy = speaking(t) || !state.greetingDone;
    const reason = budget.check(busy);
    if (reason) {
      trace("hangup", reason);
      out.event({ type: "ended", reason });
      close(reason === "max" ? "max-duration" : "silence");
    }
  }

  function close(reason = "client") {
    if (state.closed) return;
    stopReply();
    state.closed = true;
    try { state.stt?.close(); } catch { /* ignore */ }
    out.end(reason);
  }

  return {
    start,
    pushAudio,
    tick,
    close,
    onPartial,
    onCommitted,
    get state() { return state; },
    speaking: () => speaking(),
  };
}
