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
  fillerLine,
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
  "SPOKEN, NOT WRITTEN: you are heard, not read. Sound like a friendly native speaker on the phone: natural spoken word order, contractions and everyday words of that language, and fresh wording every turn (never the same opener or sentence frame twice in a row). Lead with the answer.",
  "VOICE OUTPUT: your text is read aloud by a native text-to-speech voice of the reply language. Write plain spoken sentences only in that language and its own script (Ukrainian in Ukrainian Cyrillic, Hebrew in Hebrew letters).",
  "Write numbers, temperatures, units, times and dates as words of that language (\"двадцять градусів\", \"עשרים מעלות\", \"twenty degrees\"); never digits, symbols such as ° % km/h, abbreviations, markdown, lists, or emojis. One or two short sentences.",
].join("\n");

/** Sent after a round where every lookup failed, so the model answers instead of retrying. */
export const TOOL_FAILED_NOTE = "The lookup did not give the answer. Do not call tools again in this reply. In the caller's language, say simply and warmly that you don't have that information (no technical details, never \"try again later\"), and offer what you do have from earlier real results, if anything. Never invent numbers.";

export function isToolFailure(result) {
  if (!result || typeof result !== "object") return true;
  if (result.error) return true;
  return result.isError === true;
}

/* ------------------------------ call guard ------------------------------ */

export const CALL_GUARD_TOOL = "call_guard";
/** Consecutive off-topic / trolling turns before the agent ends the call (the first gets a redirect). */
export const CALL_GUARD_END_AFTER = 2;
/** The goodbye must finish within this, then the call ends regardless. */
export const CALL_GUARD_HANGUP_MAX_MS = 9000;

export const CALL_GUARD_SPEC = {
  type: "function",
  function: {
    name: CALL_GUARD_TOOL,
    description: "Call this (before replying) when the caller's turn is NOT about your Bot task: an off-topic request, deliberate trolling or nonsense, or abuse. Never for real Bot-task questions, greetings, thanks, small talk, a place you could not find, or unclear/misheard audio.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["off_topic", "trolling", "abuse"], description: "abuse = insults, threats, harassment." },
      },
      required: ["reason"],
    },
  },
};

export const CALL_GUARD_RULES = "CALL GUARD: when a caller turn is off-topic for the Bot task, deliberate trolling, or abusive, call call_guard with the reason before you reply, then do exactly what its result says (a warm one-sentence redirect to the Bot task, or a short polite goodbye). Never call it for real Bot-task questions, greetings, thanks, short pleasantries, a place you could not find, or audio you did not understand (ask them to repeat instead).";

const GOODBYE = {
  uk: "Гаразд, тоді на все добре! До побачення.",
  es: "Bueno, ¡que vaya bien! Adiós.",
  en: "Alright, take care. Goodbye!",
  ru: "Хорошо, тогда всего доброго! До свидания.",
  fr: "D'accord, bonne journée. Au revoir !",
  ar: "حسنًا، مع السلامة.",
  he: "בסדר, שיהיה המשך יום טוב. להתראות!",
};

/** Server-side decision for a guarded turn: the model only reports the reason. */
export function guardDecision(strikes, reason) {
  if (reason === "abuse") return "end";
  return strikes >= CALL_GUARD_END_AFTER ? "end" : "redirect";
}

/* ------------------------- voice-gender agreement ------------------------- */

/** One voice per call speaks of itself in one grammatical gender. */
export function voiceGenderRule(gender = "female") {
  return gender === "male"
    ? "YOUR VOICE IS A MAN'S: whenever the language marks gender, always speak of yourself in the masculine (Ukrainian: я знайшов, зміг, перевірив, сказав; Hebrew: אני בודק; Russian: я нашёл). Never switch."
    : "YOUR VOICE IS A WOMAN'S: whenever the language marks gender, always speak of yourself in the feminine (Ukrainian: я знайшла, змогла, перевірила, сказала; Hebrew: אני בודקת; Russian: я нашла). Never switch.";
}

const MISSED = {
  // Ungendered, so they fit the call's voice.
  uk: "Вибачте, погано чути. Повторіть, будь ласка.",
  es: "Perdona, no te he oído. ¿Puedes repetirlo?",
  en: "Sorry, I didn't catch that. Could you say it again?",
  ru: "Извините, плохо слышно. Повторите, пожалуйста.",
  fr: "Pardon, je n'ai pas compris. Pouvez-vous répéter ?",
  he: "סליחה, לא שמעתי. אפשר לחזור על זה?",
};

export function bytesToMs(format, bytes) {
  if (format === "mulaw8k") return bytes / 8;
  if (format === "pcm24k") return bytes / 48;
  return bytes / 32;
}

/** Only these stop the call; a busy or failed TTS chunk is skipped and the call goes on. */
export function isFatalVoiceError(error) {
  return /(^|_)key(_|$)|quota/.test(String(error?.code || ""));
}

/**
 * Reply language for a committed caller turn. The transcript's own letters
 * and words win (they separate Ukrainian from Russian best); otherwise the
 * STT language for a turn of 2+ words; otherwise keep the call's language.
 */
export function pickReplyLanguage(established, text, sttLanguage = "", info = null) {
  const fromText = detectCallerLanguage(text);
  // A language-locked recognizer (or a re-check that compared languages) already knows.
  if (sttLanguage && (info?.locked || info?.rechecked)) {
    if (sttLanguage === "ru" && fromText === "uk") return "uk";
    return sttLanguage;
  }
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
  ttsFormat = "",
  pickVoice = null,
  greetingVoiceLanguage = "",
  endOffTopic = false,
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
    voices: {},
    guardStrikes: 0,
    hangup: null,
  };
  const outFormat = ttsFormat || format;
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
    if (outFormat === "mulaw8k") return 800; // 100 ms
    return outFormat === "pcm24k" ? 4800 : 3200;
  }

  function enqueue(buffer, replyId) {
    if (state.closed || !state.reply || state.reply.id !== replyId || !buffer?.length) return;
    let buf = Buffer.from(buffer);
    if (outFormat !== "mulaw8k") {
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
      if (state.duck && outFormat === "mulaw8k") data = Buffer.from(scaleMulawBase64(data.toString("base64"), DUCK_VOLUME), "base64");
      if (!state.replyAudioAt) {
        state.replyAudioAt = t;
        out.event({ type: "phase", state: "speaking" });
      }
      out.audio(data);
      state.playEndsAt = Math.max(t, state.playEndsAt) + bytesToMs(outFormat, chunk.data.length);
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

  /**
   * One voice per language for the whole call, chosen at first use. If the
   * HD voice fails once, the plain voice takes over for the rest of the call
   * (never back and forth between replies).
   */
  function callVoice(language) {
    if (!pickVoice) return null;
    const key = language || "_";
    if (!state.voices[key]) {
      const chosen = pickVoice(language) || {};
      state.voices[key] = { voice: chosen.voice || "", fallback: chosen.fallback || "" };
      trace("voice", `${key} ${state.voices[key].voice}`);
    }
    return state.voices[key];
  }

  function newReply(language, { voiceLanguage = language } = {}) {
    stopReply();
    const id = ++state.replySeq;
    const reply = { id, language, text: "", generating: true, abort: new AbortController(), tts: null, fillerUsed: false };
    const v = callVoice(voiceLanguage);
    reply.tts = openTts({
      language: voiceLanguage,
      format: outFormat,
      ...(v?.voice ? { voice: v.voice, fallbackVoice: v.fallback } : {}),
      onAudio: (buf) => enqueue(buf, id),
      onRetry: ({ code, status, attempt, waitMs, to }) => {
        if (code === "voice_fallback" && v && to) {
          v.voice = to;
          v.fallback = "";
          trace("voice", `${voiceLanguage || "_"} ${to} (fallback, rest of call)`);
          return;
        }
        trace("tts-retry", `${code || status} #${attempt} ${waitMs}ms`);
      },
    });
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
      if (reply.cancelled) return;
      if (isFatalVoiceError(error)) { fail(error); return; }
      // Busy / failed speech: never end the call. The reply still shows as text.
      trace("tts-error", error?.code || error?.message || "");
      out.event({ type: "notice", code: String(error?.code || "tts_error"), message: "The voice service is busy; part of the reply was not spoken." });
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
  async function speakFixed(line, language, { recordText = true, history = false, voiceLanguage = language } = {}) {
    const reply = newReply(language, { voiceLanguage });
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
    let toolsFailed = false;
    let guarded = false;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        // After a round where every lookup failed, answer now instead of retrying (each retry is another long wait).
        const allowTools = tools.length > 0 && round < MAX_TOOL_ROUNDS && !toolsFailed && !state.hangup;
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
        const lookups = calls.filter((c) => c.name !== CALL_GUARD_TOOL);
        if (lookups.length && !reply.fillerUsed && !reply.text) {
          reply.fillerTimer = setTimer(() => {
            reply.fillerTimer = null;
            if (reply.cancelled || reply.fillerUsed || reply.text) return;
            reply.fillerUsed = true;
            trace("filler");
            state.lastFiller = fillerLine(language, state.lastFiller);
            speak(reply, state.lastFiller);
          }, TOOL_FILLER_AFTER_MS);
        }
        trace("tools", calls.map((c) => c.name).join(","));
        const results = await Promise.all(calls.map((c) => {
          if (c.name !== CALL_GUARD_TOOL) return runOneTool(c);
          if (guarded) return { status: "noted" };
          guarded = true;
          return guardTurn(c, language);
        }));
        if (reply.fillerTimer) { clearTimer(reply.fillerTimer); reply.fillerTimer = null; }
        if (reply.cancelled) return;
        calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id || `call_${round}_${i}`, content: JSON.stringify(results[i]) }));
        if (lookups.length && results.every(isToolFailure)) {
          toolsFailed = true;
          trace("tools-failed", calls.map((c) => c.name).join(","));
          messages.push({ role: "system", content: TOOL_FAILED_NOTE });
        }
      }
      if (buffer.trim()) speak(reply, buffer);
    } catch (error) {
      if (reply.cancelled || error?.name === "AbortError") return;
      if (/^openai_(key|quota)/.test(String(error?.code || ""))) { fail(error); return; }
      trace("llm-error", error?.code || error?.message || "");
      speak(reply, spokenFailure("", userText, language));
    }
    if (!guarded) state.guardStrikes = 0; // only consecutive off-topic turns count
    // Never dead air: an empty answer becomes one short "didn't catch that" (or the goodbye).
    if (!reply.text.trim()) speak(reply, state.hangup ? (GOODBYE[language] || GOODBYE.en) : (MISSED[language] || MISSED.en));
    await finishReply(reply);
    if (!reply.cancelled && reply.text) pushHistory("assistant", reply.text);
  }

  /** call_guard: count the strike, decide redirect vs. end on the server, and tell the model what to say. */
  function guardTurn(call, language) {
    let args = {};
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
    const reason = ["off_topic", "trolling", "abuse"].includes(args.reason) ? args.reason : "off_topic";
    if (!endOffTopic) return { status: "redirect", say: "Reply with one short warm sentence bringing the caller back to your Bot task." };
    state.guardStrikes += 1;
    const decision = guardDecision(state.guardStrikes, reason);
    trace("guard", `${reason} strike=${state.guardStrikes} ${decision}`);
    if (decision === "redirect") {
      return { status: "redirect", say: "Reply with one short, warm sentence in the caller's language: you only help with your Bot task, and ask what they would like to know about it. No lecture." };
    }
    state.hangup = { reason, at: now(), language };
    return { status: "ending_call", say: "Say only one short, polite goodbye in the caller's language (no explanation, no question). The call ends after it." };
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

  function onCommitted(text, sttLanguage = "", info = null) {
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
    if (state.hangup) { trace("drop-after-hangup"); return; }
    if (!state.greetingDone) state.greetingDone = true;
    const language = pickReplyLanguage(state.callerLanguage, clean, sttLanguage, info);
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
    const stt = openStt({ format, onPartial, onCommitted, onError: fail, log: (kind, detail) => trace(kind, detail), agentLanguage: agent?.language || "" });
    state.stt = stt;
    try {
      await stt.ready;
    } catch (error) {
      fail(error);
      return false;
    }
    if (state.closed) return false;
    out.event({ type: "ready", playbackRate: outFormat === "pcm24k" ? 24000 : outFormat === "mulaw8k" ? 8000 : 16000 });
    const line = greetingText(agent);
    const language = greetingLanguage(agent, line);
    // A one-word English "Hello" on a multi-language line is said by the call's main voice, so the voice never changes after it.
    const multi = !agent?.language || agent.language === "multi";
    const shortEnglish = language === "en" && transcriptTokens(line).length <= 3;
    const voiceLanguage = multi && shortEnglish && greetingVoiceLanguage ? greetingVoiceLanguage : language;
    await speakFixed(line, language, { voiceLanguage });
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
    if (state.hangup && ((!speaking(t) && !state.reply?.generating) || t - state.hangup.at >= CALL_GUARD_HANGUP_MAX_MS)) {
      const why = `agent-hangup:${state.hangup.reason}`;
      trace("hangup", why);
      out.event({ type: "ended", reason: why });
      close(why);
      return;
    }
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
