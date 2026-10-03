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

test("barge-in drops the queued spoken follow-up", () => {
  const gate = createResponseGate();
  ingestRealtimeEvent(gate, { type: "response.created" });
  ingestRealtimeEvent(gate, weatherCall("barge"));
  const epoch = gate.epoch;
  noteBargeIn(gate);
  ingestRealtimeEvent(gate, { type: "response.done", response: { status: "cancelled", output: [] } });
  assert.equal(completeTool(gate, "barge", epoch, true).length, 0);
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
  assert.equal(error.send.length, 0);
  const retried = ingestRealtimeEvent(gate, {
    type: "response.done",
    response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio", transcript: "no" }] }] },
  });
  assert.equal(retried.send.length, 1);
  assert.equal(retried.send[0].type, "response.create");
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

test("dialer and media bridge do not create a response while a tool call is still open", () => {
  for (const rel of ["public/js/console-dial.js", "public/js/voice.js", "src/twilio/media-bridge.js"]) {
    const source = fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(source, /ingestRealtimeEvent\(/);
    assert.match(source, /completeTool\(/);
    assert.match(source, /functionOutputEvent\(/);
    assert.doesNotMatch(source, /function_call_output[\s\S]{0,400}response\.create/);
  }
});
