// "It stops speaking when I just say yeah": short backchannels never stop,
// cancel or re-trigger the agent; real phrases and stop words still do.
// Offline only: simulated Realtime events, no API calls.
import assert from "node:assert/strict";
import test from "node:test";
import { isBackchannel, isStopWord, transcriptTokens } from "../public/js/backchannel.js";
import {
  BARGE_IN_MIN_MS,
  SPEAK_VAD_TRIM_MS,
  createLevelVad,
  createResponseGate,
  enableSpeakVad,
  handleCallerPartial,
  handleCallerTurn,
  ingestRealtimeEvent,
  interruptionVerdict,
  localSpeechEnd,
  localSpeechStart,
  speakVadTick,
  stepLevelVad,
} from "../public/js/realtime-turn.js";

const REPLY = "У Кастельйоні зараз дев'ятнадцять градусів і мінлива хмарність, вітер слабкий.";
const EN_REPLY = "In Castellon it is nineteen degrees and partly cloudy with a light breeze.";

const BACKCHANNELS = [
  "yeah", "Yeah.", "YEAH!", "yeah yeah", "Yeah, yeah, yeah.", "yeah-yeah", "yeahhh",
  "yes", "Yes.", "ok", "OK", "Okay?", "okay okay", "okaaay", "Okay, okay.",
  "mhm", "Mm-hmm.", "mm hmm", "uh-huh", "Uh huh.", "right", "Right, right.", "yep", "sure",
  "ага", "Ага.", "Ага-ага", "ага ага", "АГА!", "так", "Так, так.", "угу", "Угу, так.",
  "да", "Да-да-да.", "ну", "Ну да.", "ну так", "ага, ага, так",
  "sí", "Sí.", "vale", "Sí, sí, vale.", "Vale, vale.",
  "...yeah...", "Yeah… ok.", "um, yeah",
];

for (const text of BACKCHANNELS) {
  test(`backchannel: ${JSON.stringify(text)}`, () => {
    assert.equal(isBackchannel(text), true);
    assert.equal(isStopWord(text), false);
    assert.notEqual(interruptionVerdict(text, REPLY), "interrupt");
  });
}

const REAL = [
  "yeah what about tomorrow", "Yeah, but what about tomorrow?", "а завтра?", "А завтра?",
  "ok stop", "Okay, wait.", "стоп", "Стоп!", "зачекайте", "Зачекайте, будь ласка", "wait", "Wait!",
  "espera", "Espera.", "stop", "ага, а в Мадриді?", "так, а скільки коштує?", "sí, pero mañana?",
  "yeah hold on", "ну подожди",
];

for (const text of REAL) {
  test(`real phrase or stop word interrupts: ${JSON.stringify(text)}`, () => {
    assert.equal(isBackchannel(text), false);
    assert.equal(interruptionVerdict(text, REPLY), "interrupt");
  });
}

test("not a backchannel: empty, filler-only, or too long", () => {
  assert.equal(isBackchannel(""), false);
  assert.equal(isBackchannel("..."), false);
  assert.equal(isBackchannel("um"), false);
  assert.equal(isBackchannel(Array(9).fill("yeah").join(" ")), false);
});

test("tokens: punctuation, case, hyphen repeats and apostrophes", () => {
  assert.deepEqual(transcriptTokens("Yeah, YEAH-yeah!"), ["yeah", "yeah", "yeah"]);
  assert.deepEqual(transcriptTokens("Ага-ага… так."), ["ага", "ага", "так"]);
  assert.deepEqual(transcriptTokens("[laughs] Ok"), ["ok"]);
});

/** Agent mid-reply over WebRTC, optionally with the local speak VAD. */
function speakingGate({ t0 = 10_000, reply = REPLY, speakVad = false } = {}) {
  const gate = createResponseGate();
  if (speakVad) enableSpeakVad(gate, { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", threshold: 0.8 } });
  const first = handleCallerTurn(gate, "Яка погода завтра в Кастельйоні?", { itemId: "u1" });
  assert.equal(first.kind, "speech");
  ingestRealtimeEvent(gate, { type: "response.created" }, { now: t0 });
  ingestRealtimeEvent(gate, { type: "output_audio_buffer.started" }, { now: t0 });
  ingestRealtimeEvent(gate, { type: "response.output_audio_transcript.delta", delta: reply }, { now: t0 + 50 });
  return { gate, first };
}

for (const text of ["yeah", "Yeah yeah.", "Ага.", "так", "Okay, okay.", "Sí, vale."]) {
  test(`while the agent talks, ${JSON.stringify(text)} keeps it talking (no cancel, no new reply)`, () => {
    const t0 = 10_000;
    const { gate } = speakingGate({ t0, reply: EN_REPLY });
    const started = ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: "bc", audio_start_ms: 0 }, { now: t0 + 2000 });
    assert.equal(started.volume, "duck");
    ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_stopped", item_id: "bc", audio_end_ms: 700 }, { now: t0 + 2700 });
    assert.equal(handleCallerPartial(gate, text, { itemId: "bc" }), null, "early start ignores it");
    const turn = handleCallerTurn(gate, text, { itemId: "bc" });
    assert.notEqual(turn.kind, "speech");
    assert.equal(turn.cancel, false);
    assert.deepEqual(turn.send, [], "no response.create");
    assert.equal(turn.volume, "restore");
    assert.equal(gate.playing, true);
    assert.equal(gate.pendingCreates.length, 0);
  });
}

test("a real phrase after 'yeah' still interrupts mid-reply", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0, reply: EN_REPLY });
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: "r", audio_start_ms: 0 }, { now: t0 + 2000 });
  assert.equal(handleCallerPartial(gate, "yeah", { itemId: "r" }), null);
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_stopped", item_id: "r", audio_end_ms: 1300 }, { now: t0 + 3300 });
  const turn = handleCallerTurn(gate, "yeah what about tomorrow", { itemId: "r" });
  assert.equal(turn.kind, "speech");
  assert.equal(turn.cancel, true);
});

test("a Ukrainian question after 'ага' stops the agent from the streaming transcript", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0 });
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: "q", audio_start_ms: 0 }, { now: t0 + 2000 });
  assert.equal(handleCallerPartial(gate, "Ага", { itemId: "q" }), null);
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_stopped", item_id: "q", audio_end_ms: 1300 }, { now: t0 + 3300 });
  const early = handleCallerPartial(gate, "Ага, а в Мадриді?", { itemId: "q" });
  assert.equal(early?.kind, "speech");
  assert.equal(early.cancel, true);
});

test("a backchannel said over speech that transcribes after playback ended is not answered", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0 });
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: "late", audio_start_ms: 0 }, { now: t0 + 2000 });
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: REPLY }] }] } }, { now: t0 + 2100 });
  ingestRealtimeEvent(gate, { type: "output_audio_buffer.stopped" }, { now: t0 + 2200 });
  assert.equal(gate.playing, false);
  const turn = handleCallerTurn(gate, "Ага, так.", { itemId: "late" });
  assert.notEqual(turn.kind, "speech");
  assert.deepEqual(turn.send, []);
});

test("when the agent is idle, 'yeah' as its own turn may be answered", () => {
  const gate = createResponseGate();
  const turn = handleCallerTurn(gate, "Yeah, yeah.", { itemId: "idle" });
  assert.equal(turn.cancel, false);
  assert.ok(["speech", "noise"].includes(turn.kind));
});

// --- WebRTC: server VAD off while the agent talks -----------------------

test("speak VAD: each reply switches server VAD off first, playback end switches it back", () => {
  const t0 = 10_000;
  const { gate, first } = speakingGate({ t0, speakVad: true });
  assert.equal(first.send[0].type, "session.update");
  assert.equal(first.send[0].session.audio.input.turn_detection, null);
  assert.equal(first.send[0].session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(first.send.at(-1).type, "response.create");
  assert.equal(gate.speakVad.mode, "local");
  const done = ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: REPLY }] }] } }, { now: t0 + 5000 });
  assert.ok(!done.send.some((e) => e.type === "session.update"), "still playing");
  const stopped = ingestRealtimeEvent(gate, { type: "output_audio_buffer.stopped" }, { now: t0 + 6000 });
  assert.deepEqual(stopped.send.map((e) => e.type), ["input_audio_buffer.clear", "session.update"]);
  assert.equal(stopped.send[1].session.audio.input.turn_detection.type, "server_vad");
  assert.equal(gate.speakVad.mode, "server");
});

test("speak VAD: a short local sound only ducks; a long one commits and its 'yeah' is ignored", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0, speakVad: true });
  assert.equal(localSpeechStart(gate, t0 + 2000).volume, "duck");
  assert.deepEqual(localSpeechEnd(gate, BARGE_IN_MIN_MS - 100, t0 + 2300).send, [], "too short to commit");
  localSpeechStart(gate, t0 + 3000);
  const end = localSpeechEnd(gate, 700, t0 + 3700);
  assert.deepEqual(end.send.map((e) => e.type), ["input_audio_buffer.commit"]);
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.committed", item_id: "c1" }, { now: t0 + 3710 });
  const turn = handleCallerTurn(gate, "Yeah.", { itemId: "c1" });
  assert.equal(turn.cancel, false);
  assert.deepEqual(turn.send, []);
  assert.equal(gate.playing, true);
});

test("speak VAD: a committed real question interrupts", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0, speakVad: true });
  localSpeechStart(gate, t0 + 2000);
  localSpeechEnd(gate, 1200, t0 + 3200);
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.committed", item_id: "c2" }, { now: t0 + 3210 });
  const turn = handleCallerTurn(gate, "А завтра в Мадриді?", { itemId: "c2" });
  assert.equal(turn.kind, "speech");
  assert.equal(turn.cancel, true);
});

test("speak VAD: quiet audio is trimmed every ~1.5 s, never mid-sound", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0, speakVad: true });
  const base = gate.speakVad.lastTrimAt;
  assert.deepEqual(speakVadTick(gate, base + SPEAK_VAD_TRIM_MS - 1), []);
  assert.deepEqual(speakVadTick(gate, base + SPEAK_VAD_TRIM_MS).map((e) => e.type), ["input_audio_buffer.clear"]);
  localSpeechStart(gate, base + SPEAK_VAD_TRIM_MS + 100);
  assert.deepEqual(speakVadTick(gate, base + SPEAK_VAD_TRIM_MS * 3), []);
});

test("speak VAD: a session.update queued mid-reply keeps VAD off until playback ends", () => {
  const t0 = 10_000;
  const { gate } = speakingGate({ t0, speakVad: true });
  gate.pendingSession = { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { type: "server_vad" } }, output: { voice: "marin" } } } };
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio" }] }] } }, { now: t0 + 3000 });
  const stopped = ingestRealtimeEvent(gate, { type: "output_audio_buffer.stopped" }, { now: t0 + 4000 });
  const sessions = stopped.send.filter((e) => e.type === "session.update");
  assert.ok(sessions.length >= 1);
  assert.equal(sessions.at(-1).session.audio.input.turn_detection.type, "server_vad", "VAD ends up on");
  assert.equal(gate.pendingSession, null);
});

test("level VAD: onset, hang and duration", () => {
  const vad = createLevelVad();
  let t = 0;
  const feed = (db, ms) => { const out = []; for (let end = t + ms; t < end; t += 20) { const s = stepLevelVad(vad, db, t); if (s.event) out.push(s); } return out; };
  assert.deepEqual(feed(-70, 1000), []);
  assert.deepEqual(feed(-30, 60), [], "too brief for onset");
  feed(-70, 200);
  const start = feed(-30, 800);
  assert.equal(start[0].event, "start");
  const end = feed(-70, 1000);
  assert.equal(end[0].event, "end");
  assert.ok(end[0].ms >= 700 && end[0].ms <= 900, String(end[0].ms));
});
