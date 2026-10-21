import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  completeTool,
  createResponseGate,
  failureLine,
  functionOutputEvent,
  ingestRealtimeEvent,
  noteBargeIn,
  noteCallerSpeech,
  applyCallerTranscript,
  queueResponseCreate,
  queueSessionUpdate,
  armToolFiller,
  silenceFallbackEvent,
  TOOL_FILLER_AFTER_MS,
  toolFollowUpEvent,
  withTimeout,
} from "../public/js/realtime-turn.js";

function weatherCall(callId = "call_weather") {
  return {
    type: "response.function_call_arguments.done",
    name: "get_weather",
    call_id: callId,
    arguments: "{}",
  };
}

test("tool follow-up waits until the function-call response is done", () => {
  const gate = createResponseGate();
  noteCallerSpeech(gate, "What's the weather?");
  ingestRealtimeEvent(gate, { type: "response.created" });
  const started = ingestRealtimeEvent(gate, weatherCall());
  assert.equal(started.toolCalls.length, 1);
  assert.equal(started.send.length, 0);

  const early = completeTool(gate, "call_weather", gate.epoch, true);
  assert.equal(early.length, 0, "response.create must not be sent while the tool response is active");

  const done = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: {
      status: "completed",
      output: [{ type: "function_call", name: "get_weather", call_id: "call_weather", arguments: "{}" }],
    },
  });
  assert.equal(done.toolCalls.length, 0);
  assert.equal(done.send.length, 1);
  assert.equal(done.send[0].type, "response.create");
  // auto: a place search may chain into the forecast lookup (capped).
  assert.equal(done.send[0].response.tool_choice, "auto");
  assert.match(done.send[0].response.instructions, /Speak the tool result/);
  assert.equal(done.hold, true);
});

test("a slow tool speaks only after both the response and the tool finish", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("slow"));
  const done = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "function_call", name: "get_weather", call_id: "slow" }] },
  });
  assert.equal(done.send.length, 0);
  assert.equal(done.hold, true);
  const follow = completeTool(gate, "slow", gate.epoch, false);
  assert.equal(follow.length, 1);
  assert.match(follow[0].response.instructions, /I can't get the weather right now/);
});

test("several tool calls in one turn produce one spoken follow-up", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("a"));
  ingestRealtimeEvent(gate, {
    type: "response.output_item.done",
    item: { type: "function_call", name: "lookup_note", call_id: "b", arguments: "{}" },
  });
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [] } });
  assert.equal(completeTool(gate, "a", gate.epoch, true).length, 0);
  const follow = completeTool(gate, "b", gate.epoch, true);
  assert.equal(follow.length, 1);
});

test("a silent weather turn speaks a failure instead of staying quiet", () => {
  const gate = createResponseGate();
  noteCallerSpeech(gate, "What is the weather?");
  ingestRealtimeEvent(gate, { type: "response.created" });
  const done = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [] },
  });
  assert.equal(done.send.length, 1);
  assert.match(done.send[0].response.instructions, /I can't get the weather right now/);
  assert.equal(done.hold, true);
});

test("noise or empty turns do not get a did-not-catch-that fallback", () => {
  for (const text of ["", "uh", "um", "a"]) {
    const gate = createResponseGate();
    noteCallerSpeech(gate, text);
    noteBargeIn(gate);
    ingestRealtimeEvent(gate, { type: "response.created" });
    const done = ingestRealtimeEvent(gate, {
      type: "response.done",
      response: { status: "completed", output: [] },
    });
    assert.equal(done.send.length, 0, JSON.stringify(text) + " must stay silent");
  }
});

test("audio responses and the greeting do not get a silence fallback", () => {
  const spoken = createResponseGate();
  noteCallerSpeech(spoken, "What is the weather?");
  ingestRealtimeEvent(spoken, { type: "response.output_audio.delta", delta: "abc" });
  const done = ingestRealtimeEvent(spoken, {
    type: "response.done",
    response: { status: "completed", output: [] },
  });
  assert.equal(done.send.length, 0);

  const greeting = createResponseGate();
  noteCallerSpeech(greeting, "hello");
  const suppressed = ingestRealtimeEvent(greeting, {
    type: "response.done",
    response: { status: "completed", output: [] },
  }, { suppressFallback: true });
  assert.equal(suppressed.send.length, 0);
});

test("barge-in while speaking drops the queued spoken follow-up", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("barge"));
  // Tool finishes while response still active → follow-up queued, not sent yet.
  assert.equal(completeTool(gate, "barge", gate.epoch, true).length, 0);
  assert.equal(gate.pendingCreates.length, 1);
  const epoch = gate.epoch;
  assert.equal(noteBargeIn(gate), true, "active response must count as barge-in");
  assert.equal(gate.pendingCreates.length, 0);
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "cancelled", output: [] } });
  assert.equal(completeTool(gate, "barge", epoch, true).length, 0);
});

test("speech during a tool wait does not drop the spoken follow-up", () => {
  const gate = createResponseGate();
  noteCallerSpeech(gate, "What's the weather in Madrid?");
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("wait"));
  // Function-call response finished; MCP tool still running.
  ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "function_call", name: "get_weather", call_id: "wait" }] },
  });
  assert.equal(gate.active, false);
  assert.equal(gate.tools.size, 1);
  const epoch = gate.epoch;
  assert.equal(noteBargeIn(gate), false, "noise during tool wait must not barge-in");
  assert.equal(gate.epoch, epoch);
  const follow = completeTool(gate, "wait", epoch, true);
  assert.equal(follow.length, 1, "tool follow-up must still speak after tool wait noise");
  assert.match(follow[0].response.instructions, /Speak the tool result/);
});

test("cancelled or incomplete turns do not inject a silence fallback create", () => {
  for (const status of ["cancelled", "incomplete"]) {
    const gate = createResponseGate();
    noteCallerSpeech(gate, "Tell me about hours");
    ingestRealtimeEvent(gate, { type: "response.created" });
    ingestRealtimeEvent(gate, { type: "response.output_audio.delta", delta: "x" });
    // Barge-in clears heardAudio the way a real interrupt does mid-reply.
    noteBargeIn(gate);
    const done = ingestRealtimeEvent(gate, {
      type: "response.done",
      response: { status, output: [] },
    });
    assert.equal(done.send.length, 0, `${status} must not race a fallback create into the next caller turn`);
  }
});

test("a second response.create while active is queued, not sent", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  const queued = queueResponseCreate(gate, silenceFallbackEvent("hello"));
  assert.equal(queued.length, 0);
  assert.equal(gate.pendingCreates.length, 1);
  const done = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: "hi" }] }] },
  });
  assert.equal(done.send.length, 1);
  assert.equal(done.send[0].type, "response.create");
});

test("an active-response error is retried once the current response finishes", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("race"));
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [] } });
  const follow = completeTool(gate, "race", gate.epoch, true);
  assert.equal(follow.length, 1);
  const error = ingestRealtimeEvent(gate, {
    type: "error",
    error: { message: "Conversation already has an active response in progress" },
  });
  assert.equal(error.send.length, 0, "must not immediately re-send and loop the active-response error");
  assert.equal(gate.waitingForIdle, true);
  assert.equal(gate.pendingCreates.length, 1);
  const retried = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: "no" }] }] },
  });
  assert.equal(retried.send.length, 1);
  assert.equal(retried.send[0].type, "response.create");
});

test("after a completed spoken turn the gate is idle for the next caller question", () => {
  const gate = createResponseGate();
  noteCallerSpeech(gate, "What can you help with?");
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, { type: "response.output_audio.delta", delta: "abc" });
  const done = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: "I can help with weather." }] }] },
  });
  assert.equal(done.send.length, 0);
  assert.equal(done.hold, false);
  assert.equal(gate.active, false);
  assert.equal(gate.pendingCreates.length, 0);
  // Next caller turn can start cleanly — no leftover create racing their audio.
  assert.equal(noteBargeIn(gate), false);
  assert.equal(gate.epoch, 0);
});

test("tool output event and weather failure line are speakable", () => {
  assert.equal(failureLine("get_weather"), "I can't get the weather right now.");
  assert.equal(failureLine("lookup", "will it rain today?"), "I can't get the weather right now.");
  assert.equal(failureLine("lookup"), "I can't do that right now.");
  const event = functionOutputEvent("call_1", { error: failureLine("get_weather") });
  assert.equal(event.item.type, "function_call_output");
  assert.match(event.item.output, /can't get the weather/);
});

test("withTimeout returns the spoken fallback when a tool hangs", async () => {
  const result = await withTimeout(new Promise(() => {}), 15, () => ({ error: failureLine("get_forecast") }));
  assert.equal(result.error, "I can't get the weather right now.");
});

test("dialer, voice test, and media bridge share the gated turn path", () => {
  for (const rel of ["public/js/console-dial.js", "public/js/voice.js", "src/twilio/media-bridge.js"]) {
    const source = fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(source, /ingestRealtimeEvent\(/);
    assert.match(source, /completeTool\(/);
    assert.match(source, /functionOutputEvent\(/);
    assert.match(source, /queueResponseCreate\(/);
    assert.doesNotMatch(source, /function_call_output[\s\S]{0,400}response\.create/);
  }
  const bridge = fs.readFileSync(new URL("../src/twilio/media-bridge.js", import.meta.url), "utf8");
  assert.match(bridge, /responseGate\.active/);
  assert.doesNotMatch(
    bridge,
    /speech_started[\s\S]{0,200}sendTwilio\(\{ event: "clear"[\s\S]{0,120}sendOpenAi\(\{ type: "response\.cancel" \}\);(?![\s\S]*responseGate\.active)/,
  );
});

test("a Ukrainian Castellón weather turn is not rewritten into English", () => {
  const uk = "Привіт, скажи мені, будь ласка, яка сьогодні погода в Кастельон-де-ла-Плана?";
  const follow = toolFollowUpEvent("get_weather", false, uk);
  assert.match(follow.response.instructions, /Кастельон-де-ла-Плана/);
  assert.match(follow.response.instructions, /Ukrainian/);
  assert.match(follow.response.instructions, /Speak the tool result/);
  assert.doesNotMatch(follow.response.instructions, /Reply in English/);
  assert.doesNotMatch(follow.response.instructions, /What is the weather in/);
  const gate = createResponseGate();
  noteCallerSpeech(gate, uk);
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("uk"));
  ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "function_call", name: "get_weather", call_id: "uk" }] },
  });
  const sent = completeTool(gate, "uk", gate.epoch, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].response.instructions, /Кастельон-де-ла-Плана/);
});

test("session language update waits until the model is done speaking", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, { type: "response.output_audio.delta", delta: "abc" });
  const early = queueSessionUpdate(gate, {
    type: "session.update",
    session: { type: "realtime", instructions: "Reply only in Ukrainian." },
  });
  assert.equal(early.length, 0, "must not rewrite the session mid-reply");
  assert.ok(gate.pendingSession);
  noteBargeIn(gate);
  const done = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "cancelled", output: [] },
  });
  assert.equal(done.send.length, 1);
  assert.equal(done.send[0].type, "session.update");
  assert.match(done.send[0].session.instructions, /Ukrainian/);
  assert.equal(gate.pendingSession, null);
});

test("one still-looking line only if the tool is still running", async () => {
  const uk = "Привіт, скажи мені, будь ласка, яка сьогодні погода?";
  const fast = createResponseGate();
  noteCallerSpeech(fast, uk);
  ingestRealtimeEvent(fast, { type: "response.created" });
  ingestRealtimeEvent(fast, weatherCall("fast"));
  ingestRealtimeEvent(fast, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "function_call", name: "get_weather", call_id: "fast" }] },
  });
  const earlyAudio = [];
  armToolFiller(fast, (event) => earlyAudio.push(event));
  const answer = completeTool(fast, "fast", fast.epoch, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(earlyAudio.length, 0, "a fast tool must not speak a filler");
  assert.equal(answer.length, 1);
  assert.match(answer[0].response.instructions, /Ukrainian/);
  assert.doesNotMatch(answer[0].response.instructions, /Ще дивлюся/);

  const slow = createResponseGate();
  noteCallerSpeech(slow, uk);
  ingestRealtimeEvent(slow, { type: "response.created" });
  ingestRealtimeEvent(slow, weatherCall("slow"));
  ingestRealtimeEvent(slow, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "function_call", name: "get_weather", call_id: "slow" }] },
  });
  const heard = [];
  armToolFiller(slow, (event) => heard.push(event));
  await new Promise((resolve) => setTimeout(resolve, TOOL_FILLER_AFTER_MS + 100));
  assert.equal(heard.length, 1);
  assert.match(heard[0].response.instructions, /Ще дивлюся/);
  assert.equal(slow.active, true);
  const queued = completeTool(slow, "slow", slow.epoch, true);
  assert.equal(queued.length, 0, "the real answer waits until the filler finishes");
  const done = ingestRealtimeEvent(slow, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: "Ще дивлюся." }] }] },
  });
  assert.equal(done.send.length, 1);
  assert.match(done.send[0].response.instructions, /Ukrainian/);
  assert.match(done.send[0].response.instructions, /Кастельон|погода|Speak the tool result/);
});

test("late transcript rewrites a pending tool answer and can restart a wrong-language reply", () => {
  const uk = "Яка погода в Кастельон-де-ла-Плана?";
  const gate = createResponseGate();
  // Auto-reply already started before transcription arrived.
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, { type: "response.output_audio.delta", delta: "x" });
  const early = applyCallerTranscript(gate, uk);
  assert.equal(early.language, "uk");
  assert.equal(early.changed, true);
  assert.equal(early.restart, true);
  assert.equal(gate.pendingCreates.length, 1);
  assert.match(gate.pendingCreates[0].response.instructions, /Ukrainian/);
  assert.match(gate.pendingCreates[0].response.instructions, /Кастельон-де-ла-Плана|Яка погода/);

  // Tool path: follow-up is queued behind an active response; late transcript rewrites it.
  const toolGate = createResponseGate();
  ingestRealtimeEvent(toolGate, { type: "response.created" });
  toolGate.pendingCreates = [toolFollowUpEvent("get_weather", false, "uh", "")];
  assert.doesNotMatch(toolGate.pendingCreates[0].response.instructions, /Ukrainian/);
  const late = applyCallerTranscript(toolGate, uk);
  assert.equal(late.language, "uk");
  assert.equal(late.restart, false, "must not replace a queued tool follow-up");
  assert.equal(toolGate.pendingCreates.length, 1);
  assert.match(toolGate.pendingCreates[0].response.instructions, /Ukrainian/);
  assert.match(toolGate.pendingCreates[0].response.instructions, /Speak the tool result/);
});

test("per-reply instructions never drop the Bot task (response.instructions replaces session instructions)", async () => {
  const { withSessionInstructions, toolFillerEvent } = await import("../public/js/realtime-turn.js");
  const { buildRealtimeSession } = await import("../src/realtime.js");
  const base = buildRealtimeSession("gpt-realtime-2.1", "en", {
    systemPrompt: "You are Weather. Your mission is the weather.",
    greeting: "Hello",
  }).instructions;
  const restart = {
    type: "response.create",
    response: { output_modalities: ["audio"], instructions: "Reply only in Ukrainian. Answer now in that language." },
  };
  const sent = withSessionInstructions(restart, base);
  assert.ok(sent.response.instructions.startsWith(base));
  assert.match(sent.response.instructions, /Bot task:\nYou are Weather/);
  assert.match(sent.response.instructions, /For this reply only: Reply only in Ukrainian/);
  assert.equal(withSessionInstructions(sent, base), sent, "idempotent");
  assert.match(withSessionInstructions(toolFillerEvent("Що ти вмієш?"), base).response.instructions, /never let them pull you into English/);
  const plain = { type: "response.create" };
  assert.equal(withSessionInstructions(plain, base), plain);
  const update = { type: "session.update", session: { instructions: "x" } };
  assert.equal(withSessionInstructions(update, base), update);
});

test("English greeting does not anchor the reply language; correct replies are not restarted", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const note = RT.greetingLanguageNote();
  assert.equal(note.type, "conversation.item.create");
  assert.equal(note.item.role, "system");
  assert.match(note.item.content[0].text, /not the caller's language/);

  const voice = fs.readFileSync(new URL("../public/js/voice.js", import.meta.url), "utf8");
  const dial = fs.readFileSync(new URL("../public/js/console-dial.js", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../src/twilio/media-bridge.js", import.meta.url), "utf8");
  for (const source of [voice, dial, bridge]) assert.match(source, /greetingLanguageNote\(\)/);

  assert.equal(RT.replyInLanguage("Я даю", "uk"), true);
  assert.equal(RT.replyInLanguage("I give you", "uk"), false);
  assert.equal(RT.replyInLanguage("Это погода", "uk"), false);
  assert.equal(RT.replyInLanguage("", "uk"), false);

  const gate = RT.createResponseGate();
  RT.ingestRealtimeEvent(gate, { type: "response.created" });
  RT.ingestRealtimeEvent(gate, { type: "response.output_audio_transcript.delta", delta: "Я даю поточну" });
  assert.equal(RT.applyCallerTranscript(gate, "Що ти вмієш?").restart, false, "already Ukrainian: no cut");

  const english = RT.createResponseGate();
  RT.ingestRealtimeEvent(english, { type: "response.created" });
  RT.ingestRealtimeEvent(english, { type: "response.output_audio_transcript.delta", delta: "I give you" });
  assert.equal(RT.applyCallerTranscript(english, "Що ти вмієш?").restart, true, "English reply to Ukrainian is restarted");
});

test("noise, filler and hallucinated transcripts never get a reply", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const { classifyCallerTranscript } = await import("../public/js/caller-language.js");
  for (const t of ["", " ", "...", "Thank you.", "you", "Продолжение следует...", "Субтитры сделал DimaTorzok", "Мм.", "Uh, um.", "a", "Это место."]) {
    assert.equal(classifyCallerTranscript(t), "noise", JSON.stringify(t));
    const gate = RT.createResponseGate();
    const out = RT.handleCallerTurn(gate, t, { itemId: "item_n" });
    assert.notEqual(out.kind, "speech");
    assert.equal(out.send.length, 0);
    assert.equal(gate.pendingCreates.length, 0);
  }
  for (const t of ["Що ти вмієш?", "Hola", "Так", "Valencia", "¿Qué tiempo hace en Valencia?"]) {
    assert.equal(classifyCallerTranscript(t), "speech", t);
  }
});

test("every caller turn is answered by one response.create with a hard language line", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const cases = [
    ["Що ти вмієш?", /Reply ONLY in Ukrainian/],
    ["Яка погода в Кастельйоні?", /Reply ONLY in Ukrainian/],
    ["Что ты умеешь?", /Reply ONLY in Russian/],
    ["¿Qué tiempo hace en Valencia?", /Reply ONLY in Spanish/],
    ["Hello, what is the weather today?", /Reply ONLY in English/],
  ];
  for (const [text, line] of cases) {
    const gate = RT.createResponseGate();
    const out = RT.handleCallerTurn(gate, text, { itemId: "item_1" });
    assert.equal(out.kind, "speech");
    assert.equal(out.cancel, false);
    assert.equal(out.send.length, 1);
    assert.equal(out.send[0].type, "response.create");
    assert.match(out.send[0].response.instructions, line, text);
    assert.equal(out.send[0].response.tool_choice, "auto");
  }
});

test("only real speech of at least 400 ms interrupts the agent", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const gate = RT.createResponseGate();
  RT.ingestRealtimeEvent(gate, { type: "response.created" });
  RT.ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: "short", audio_start_ms: 1000 });
  RT.ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_stopped", item_id: "short", audio_end_ms: 1250 });
  assert.equal(RT.handleCallerTurn(gate, "Ну так", { itemId: "short" }).cancel, false);
  assert.equal(RT.handleCallerTurn(gate, "Thank you.", { itemId: "x" }).cancel, false);
  RT.ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_started", item_id: "long", audio_start_ms: 2000 });
  RT.ingestRealtimeEvent(gate, { type: "input_audio_buffer.speech_stopped", item_id: "long", audio_end_ms: 3200 });
  const barge = RT.handleCallerTurn(gate, "Стоп, а яка погода в Валенсії?", { itemId: "long" });
  assert.equal(barge.cancel, true);
  assert.equal(barge.send.length, 0, "reply waits for the cancelled response to settle");
  const done = RT.ingestRealtimeEvent(gate, { type: "response.done", response: { status: "cancelled", output: [] } });
  assert.equal(done.send.length, 1);
  assert.match(done.send[0].response.instructions, /Reply ONLY in Ukrainian/);
});

test("a streaming transcript starts the reply early and the final one is not answered twice", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const gate = RT.createResponseGate();
  assert.equal(RT.handleCallerPartial(gate, "Що", { itemId: "i1" }), null);
  const early = RT.handleCallerPartial(gate, "Що ти вмієш", { itemId: "i1" });
  assert.equal(early.kind, "speech");
  assert.equal(early.send.length, 1);
  assert.match(early.send[0].response.instructions, /Reply ONLY in Ukrainian/);
  assert.equal(RT.handleCallerPartial(gate, "Що ти вмієш?", { itemId: "i1" }), null);
  const final = RT.handleCallerTurn(gate, "Що ти вмієш?", { itemId: "i1" });
  assert.equal(final.kind, "answered");
  assert.equal(final.send.length, 0);
  assert.equal(gate.userText, "Що ти вмієш?");
});

test("a place search may chain into the forecast lookup, capped", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const gate = RT.createResponseGate();
  RT.handleCallerTurn(gate, "Яка погода в Кастельйоні?", { itemId: "w" });
  RT.ingestRealtimeEvent(gate, { type: "response.created" });
  RT.ingestRealtimeEvent(gate, { type: "response.function_call_arguments.done", name: "openmeteo_search_locations", call_id: "c1", arguments: "{}" });
  RT.ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [] } });
  const follow = RT.completeTool(gate, "c1", gate.epoch, true);
  assert.equal(follow[0].response.tool_choice, "auto");
  assert.match(follow[0].response.instructions, /call that lookup now/);
  assert.match(follow[0].response.instructions, /Reply only in Ukrainian/);
  const failed = RT.toolFollowUpEvent("weather", true, "Яка погода?", "uk", { allowMore: true });
  assert.equal(failed.response.tool_choice, "none");
});

test("a silent reply is retried once, never answered with 'please repeat'", async () => {
  const RT = await import("../public/js/realtime-turn.js");
  const gate = RT.createResponseGate();
  const first = RT.handleCallerTurn(gate, "Що ти вмієш?", { itemId: "s" });
  RT.ingestRealtimeEvent(gate, { type: "response.created" });
  const done = RT.ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [] } });
  assert.equal(done.send.length, 1);
  assert.equal(done.send[0], first.send[0]);
  assert.doesNotMatch(done.send[0].response.instructions, /didn't catch|не розчув/);
  RT.ingestRealtimeEvent(gate, { type: "response.created" });
  const again = RT.ingestRealtimeEvent(gate, { type: "response.done", response: { status: "completed", output: [] } });
  assert.equal(again.send.length, 0, "no endless retries");
});
