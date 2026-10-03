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
  queueResponseCreate,
  silenceFallbackEvent,
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
  assert.equal(done.send[0].response.tool_choice, "none");
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
