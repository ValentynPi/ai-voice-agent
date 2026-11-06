// Barge-in: sound while the agent talks only ducks it; only confirmed
// interrupting speech stops it. Offline: simulated Realtime events only.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DUCK_CONFIRM_MS,
  DUCK_VOLUME,
  ECHO_GUARD_MS,
  bargeTick,
  createResponseGate,
  handleCallerPartial,
  handleCallerTurn,
  ingestRealtimeEvent,
  interruptionVerdict,
  isEchoOf,
  toCachedResponse,
} from "../public/js/realtime-turn.js";
import { mulawDecode, mulawDurationMs, scaleMulawBase64 } from "../src/twilio/mulaw.js";

const REPLY = "У Кастельйоні зараз дев'ятнадцять градусів і мінлива хмарність, вітер слабкий.";

/** A Ukrainian call where the agent is mid-reply (WebRTC playback running). */
function speakingGate(t0 = 10_000) {
  const gate = createResponseGate();
  gate.botTask = "the weather";
  const first = handleCallerTurn(gate, "Яка погода в Кастельйоні?", { itemId: "u1" });
  assert.equal(first.kind, "speech");
  ingestRealtimeEvent(gate, { type: "response.created" }, { now: t0 });
  ingestRealtimeEvent(gate, { type: "output_audio_buffer.started" }, { now: t0 });
  ingestRealtimeEvent(gate, { type: "response.output_audio_transcript.delta", delta: REPLY }, { now: t0 + 50 });
  return gate;
}

function soundAt(gate, itemId, now, ms = 900) {
  const started = ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: itemId, audio_start_ms: 0 }, { now });
  ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_stopped", item_id: itemId, audio_end_ms: ms }, { now: now + ms });
  return started;
}

const NOT_INTERRUPTIONS = [
  ["noise burst (empty transcript)", ""],
  ["noise burst (punctuation)", "..."],
  ["cough", "Кх-кх."],
  ["cough description", "[cough]"],
  ["hallucinated subtitle", "Продолжение следует..."],
  ["backchannel uk", "Ага."],
  ["backchannel uk 2", "Угу, так."],
  ["backchannel en", "Mm-hmm, yeah."],
  ["backchannel es", "Sí, vale."],
  ["echo of the agent's words", "зараз дев'ятнадцять градусів"],
  ["echo, one word", "хмарність"],
];

for (const [name, text] of NOT_INTERRUPTIONS) {
  test(`while the agent talks, ${name} ducks but never stops it`, () => {
    const t0 = 10_000;
    const gate = speakingGate(t0);
    const started = soundAt(gate, `n-${name}`, t0 + 1500);
    assert.equal(started.volume, "duck", "sound ducks the agent first");
    assert.ok(gate.duck);
    const partial = handleCallerPartial(gate, text, { itemId: `n-${name}` });
    assert.equal(partial, null, "a partial of it never starts a reply");
    const turn = handleCallerTurn(gate, text, { itemId: `n-${name}` });
    assert.notEqual(turn.kind, "speech");
    assert.equal(turn.cancel, false, "the agent keeps talking");
    assert.deepEqual(turn.send, [], "no reply to it, no 'please repeat'");
    assert.equal(turn.deleteItem, true, "dropped from the model's context");
    assert.equal(turn.volume, "restore", "volume comes back");
    assert.equal(gate.duck, null);
    assert.equal(gate.playing, true);
  });
}

test("a real interruption stops the agent and the new turn is answered in Ukrainian", () => {
  const t0 = 10_000;
  const gate = speakingGate(t0);
  assert.equal(soundAt(gate, "real", t0 + 1500, 1300).volume, "duck");
  assert.equal(interruptionVerdict("стоп, а в Мадриді?", REPLY), "interrupt");
  // The streaming transcript confirms it before the final one.
  const early = handleCallerPartial(gate, "Стоп, а в Мадриді?", { itemId: "real" });
  assert.equal(early.kind, "speech");
  assert.equal(early.cancel, true, "stop the agent");
  assert.equal(early.volume, "restore");
  assert.equal(early.language, "uk");
  // The reply waits for the cancelled response to settle, then goes out.
  const settled = ingestRealtimeEvent(gate, { type: "response.done", response: { status: "cancelled", output: [] } }, { now: t0 + 3000 });
  assert.equal(settled.send.length, 1);
  const wire = toCachedResponse(settled.send[0], { botTask: gate.botTask });
  assert.match(wire[0].item.content[0].text, /^For this reply only: Reply ONLY in Ukrainian\./);
  assert.match(wire[0].item.content[0].text, /Stay on: the weather/);
  assert.equal(wire[1].response.instructions, undefined, "cost savings kept: no per-response instructions");
  // The final transcript of the same item is not answered twice.
  assert.equal(handleCallerTurn(gate, "Стоп, а в Мадриді?", { itemId: "real" }).kind, "answered");
});

test("only the real interruption stops the agent across a noisy reply", () => {
  const t0 = 10_000;
  const gate = speakingGate(t0);
  const heard = [["a", ""], ["b", "Кх-кх."], ["c", "Ага."], ["d", "градусів"], ["e", "Стоп, а в Мадриді?"]];
  const stops = [];
  heard.forEach(([id, text], i) => {
    soundAt(gate, id, t0 + 600 + i * 1500);
    const turn = handleCallerTurn(gate, text, { itemId: id });
    if (turn.cancel) stops.push(text);
  });
  assert.deepEqual(stops, ["Стоп, а в Мадриді?"]);
});

test("explicit stop words interrupt even as one short word", () => {
  for (const word of ["Стоп!", "Зачекайте", "Wait", "Espera"]) {
    assert.equal(interruptionVerdict(word, REPLY), "interrupt", word);
  }
  assert.equal(interruptionVerdict("Так", REPLY), "backchannel");
  assert.equal(interruptionVerdict("Ні", REPLY), "short", "one 2-letter word is not enough");
  assert.equal(interruptionVerdict("А завтра?", REPLY), "interrupt");
  assert.equal(interruptionVerdict("Мадрид", REPLY), "interrupt", "six letters");
});

test("an unconfirmed duck restores the volume after ~1.2 s and the reply goes on", () => {
  const t0 = 10_000;
  const gate = speakingGate(t0);
  assert.equal(soundAt(gate, "tv", t0 + 1000, 300).volume, "duck");
  assert.equal(bargeTick(gate, t0 + 1000 + DUCK_CONFIRM_MS - 1), "");
  assert.equal(bargeTick(gate, t0 + 1000 + DUCK_CONFIRM_MS), "restore");
  assert.equal(gate.duck, null);
  assert.equal(gate.playing, true, "nothing was cancelled");
  assert.ok(DUCK_VOLUME > 0.2 && DUCK_VOLUME < 0.4);
});

test("sound in the first 400 ms of a reply (its own echo) does not even duck", () => {
  const t0 = 10_000;
  const gate = speakingGate(t0);
  assert.equal(soundAt(gate, "echo", t0 + ECHO_GUARD_MS - 100).volume, "");
  assert.ok(!gate.duck);
  assert.equal(soundAt(gate, "later", t0 + ECHO_GUARD_MS + 100).volume, "duck");
});

test("playback end restores a duck; the tail echo after playback is dropped", () => {
  const t0 = 10_000;
  const gate = speakingGate(t0);
  soundAt(gate, "x", t0 + 1000);
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: REPLY }] }] } }, { now: t0 + 1100 });
  const stopped = ingestRealtimeEvent(gate, { type: "output_audio_buffer.stopped" }, { now: Date.now() });
  assert.equal(stopped.volume, "restore");
  assert.equal(gate.playing, false);
  const tail = handleCallerTurn(gate, "вітер слабкий", { itemId: "tail" });
  assert.equal(tail.kind, "noise");
  assert.equal(tail.reason, "echo");
  assert.deepEqual(tail.send, []);
});

test("when the agent is quiet the noise gate still applies and real turns are answered", () => {
  const gate = createResponseGate();
  for (const noise of ["", "...", "Ага", "[cough]", "Продолжение следует..."]) {
    const turn = handleCallerTurn(gate, noise, { itemId: `q-${noise}` });
    assert.equal(turn.kind, "noise", noise);
    assert.deepEqual(turn.send, []);
  }
  const real = handleCallerTurn(gate, "Що ти вмієш?", { itemId: "q-real" });
  assert.equal(real.kind, "speech");
  assert.equal(real.cancel, false);
  assert.equal(real.send.length, 1);
  assert.match(real.send[0].response.instructions, /^Reply ONLY in Ukrainian/);
});

test("speech after the response is done but while audio still plays clears it and answers now", () => {
  const t0 = 10_000;
  const gate = speakingGate(t0);
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio" }] }] } }, { now: t0 + 500 });
  assert.equal(gate.active, false);
  assert.equal(gate.playing, true);
  const turn = handleCallerTurn(gate, "А яка погода в Мадриді?", { itemId: "late" });
  assert.equal(turn.kind, "speech");
  assert.equal(turn.cancel, true, "clear the playing audio");
  assert.equal(turn.send.length, 1, "answer right away (no response to wait for)");
});

test("echo detection", () => {
  assert.equal(isEchoOf("дев'ятнадцять градусів", REPLY), true);
  assert.equal(isEchoOf("Кастельйона", REPLY), true, "inflected form of a word it said");
  assert.equal(isEchoOf("а в Мадриді", REPLY), false);
  assert.equal(isEchoOf("anything", ""), false);
});

test("Twilio ducking scales μ-law audio and paces by duration", () => {
  const loud = Buffer.from([0x80, 0x00, 0x8f, 0x0f]).toString("base64");
  const quiet = Buffer.from(scaleMulawBase64(loud, DUCK_VOLUME), "base64");
  const before = [...Buffer.from(loud, "base64")].map(mulawDecode);
  const after = [...quiet].map(mulawDecode);
  after.forEach((v, i) => assert.ok(Math.abs(v) <= Math.abs(before[i]) * DUCK_VOLUME * 1.1 + 64, `${v} vs ${before[i]}`));
  assert.equal(scaleMulawBase64(loud, 1), loud);
  assert.equal(mulawDurationMs(Buffer.alloc(8000).toString("base64")), 1000);
});

test("server logs the browser barge-in trace and the hang-up reason (free evidence)", async () => {
  const { logCallTrace } = await import("../src/server.js");
  const seen = [];
  const original = console.info;
  console.info = (line) => seen.push(String(line));
  try {
    const n = logCallTrace("call_9", [
      { t: Date.UTC(2026, 9, 21, 21, 4, 20), kind: "duck", detail: "sound" },
      { t: Date.UTC(2026, 9, 21, 21, 4, 21), kind: "drop-echo", detail: "градусів\nx" },
      { kind: "client", detail: "barge-v1" },
    ]);
    assert.equal(n, 3);
  } finally {
    console.info = original;
  }
  assert.equal(seen[0], "call-trace call_9 21:04:20.000 duck sound");
  assert.equal(seen[1], "call-trace call_9 21:04:21.000 drop-echo градусів x");
  assert.equal(logCallTrace("call_9", "nope"), 0);
});
