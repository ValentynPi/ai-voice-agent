import assert from "node:assert/strict";
import test from "node:test";
import {
  clipLesson,
  formatModelNotes,
  mergeLessonsIntoNotes,
  parseLessonLines,
  reviewEndedCall,
} from "../src/call-review.js";
import { DEMO_ACCOUNT_ID } from "../src/accounts.js";
import { getDb, resetDatabase } from "../src/db.js";
import { createAgent, getAgent, getHistoryCall, saveCallRecord } from "../src/desk.js";
import { receptionistInstructions } from "../src/realtime.js";
import { app } from "../src/server.js";
import { appendMessage, endCall, recordToolCall, resetStore, startCall } from "../src/store.js";

test.beforeEach(() => {
  resetDatabase();
  resetStore();
  delete process.env.OPENAI_API_KEY;
});

async function withServer(fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("lesson merge keeps preamble and prunes oldest when over cap", () => {
  const base = mergeLessonsIntoNotes("Keep the weather mission.", [
    "Always answer in the caller's language.",
  ]);
  assert.match(base, /Keep the weather mission/);
  assert.match(base, /Lessons:/);
  assert.match(base, /Always answer in the caller's language/);

  const many = [];
  for (let i = 0; i < 12; i += 1) many.push(`Lesson number ${i} about never going silent on the caller.`);
  const capped = mergeLessonsIntoNotes("Mission stays.", many);
  const { preamble, lessons } = parseLessonLines(capped);
  assert.equal(preamble, "Mission stays.");
  assert.ok(lessons.length <= 8);
  assert.ok(!lessons.some((line) => line.includes("Lesson number 0")));
  assert.ok(lessons.at(-1).includes("Lesson number 11"));
  assert.ok(capped.length <= 1800);
});

test("clipLesson truncates without inventing content", () => {
  const long = "x".repeat(200);
  const clipped = clipLesson(long);
  assert.equal(clipped.length, 140);
  assert.ok(clipped.endsWith("…"));
});

test("formatModelNotes can stand alone with only lessons", () => {
  const notes = formatModelNotes("", ["Reply in Ukrainian when the caller speaks Ukrainian."]);
  assert.equal(parseLessonLines(notes).lessons.length, 1);
});

test("model notes are injected into realtime instructions", () => {
  const sessionText = receptionistInstructions("en", {
    systemPrompt: "You report weather for cities.",
    language: "multi",
    modelNotes: "Lessons:\n- Never refuse a clear Castellón weather ask.",
  });
  assert.match(sessionText, /Bot task:\nYou report weather/);
  assert.match(sessionText, /Model notes \(durable lessons — follow them for behavior only/);
  assert.match(sessionText, /Never refuse a clear Castellón weather ask/);
  assert.match(sessionText, /never invent business facts/i);
});

test("heuristic review appends a silence lesson and history note", async () => {
  const agent = createAgent({
    name: "Weather Learn",
    systemPrompt: "You report live weather for cities. Do not invent temperatures.",
    greeting: "Hi, weather desk.",
    modelNotes: "",
  }, DEMO_ACCOUNT_ID);

  const call = startCall({
    source: "browser",
    agentId: agent.id,
    agentName: agent.name,
    accountId: DEMO_ACCOUNT_ID,
  });
  // Mutate the live call object (startCall returns a public copy).
  const live = (await import("../src/store.js")).getCall(call.id);
  appendMessage(call.id, { role: "user", text: "What's the weather in Castellón?" });
  // No assistant reply → silence failure.
  recordToolCall({
    callId: call.id,
    name: "get_place_weather",
    group: "mcp",
    args: { place: "Castellón" },
    decision: "allow",
    ok: false,
    result: { error: "timeout" },
  });
  endCall(call.id, "client");

  // endCall already triggered save + async review; wait for review to finish.
  await new Promise((resolve) => setTimeout(resolve, 80));
  // If the async hook raced, run explicitly once more (idempotent append).
  await reviewEndedCall(live || { ...call, status: "ended", endReason: "client", messages: [{ role: "user", text: "What's the weather in Castellón?" }] });

  const updated = getAgent(agent.id, DEMO_ACCOUNT_ID);
  assert.match(updated.systemPrompt, /You report live weather/);
  assert.match(updated.modelNotes, /Lessons:/);
  assert.match(updated.modelNotes, /dead air|Always answer|lookup fails|never invent/i);

  const history = getHistoryCall(call.id, [], DEMO_ACCOUNT_ID);
  assert.ok(history);
  assert.match(history.reviewNote || "", /Reviewed/);
  assert.ok((history.reviewLessons || 0) >= 1);
});

test("good short call records Reviewed · no change without touching Bot task", async () => {
  const agent = createAgent({
    name: "Weather Fine",
    systemPrompt: "You report live weather for cities.",
    greeting: "Hi.",
    modelNotes: "Operator note: keep short.",
  }, DEMO_ACCOUNT_ID);

  const started = startCall({
    source: "browser",
    agentId: agent.id,
    agentName: agent.name,
    accountId: DEMO_ACCOUNT_ID,
  });
  appendMessage(started.id, { role: "user", text: "Thanks, that helped." });
  appendMessage(started.id, { role: "assistant", text: "You're welcome. Anything else about the weather?" });
  const live = (await import("../src/store.js")).getCall(started.id);
  endCall(started.id, "client");
  await reviewEndedCall(live);

  const updated = getAgent(agent.id, DEMO_ACCOUNT_ID);
  assert.equal(updated.systemPrompt, "You report live weather for cities.");
  assert.equal(updated.modelNotes, "Operator note: keep short.");

  const history = getHistoryCall(started.id, [], DEMO_ACCOUNT_ID);
  assert.equal(history.reviewNote, "Reviewed · no change");
  assert.equal(history.reviewLessons, 0);
});

test("history API surfaces reviewNote after call end", async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Review API",
        systemPrompt: "You report weather.",
        greeting: "Hello.",
      }),
    }).then((r) => r.json());
    const agentId = created.agent.id;

    const { call } = await fetch(`${base}/api/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    }).then((r) => r.json());

    await fetch(`${base}/api/realtime/utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId: call.id, role: "user", text: "Cuál es el clima en Madrid?" }),
    });
    // No assistant reply — silence.

    await fetch(`${base}/api/calls/${call.id}/end`, { method: "POST" });

    // Poll briefly for async review.
    let note = "";
    for (let i = 0; i < 20; i += 1) {
      const body = await fetch(`${base}/api/history/${call.id}`).then((r) => r.json());
      note = body.call?.reviewNote || "";
      if (note) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(note, /Reviewed/);

    const agent = await fetch(`${base}/api/agents/${agentId}`).then((r) => r.json());
    // Either learned a lesson or recorded no change; Bot task must remain.
    assert.match(agent.agent.systemPrompt, /You report weather/);
  });
});

test("review columns exist on call_records", () => {
  const cols = new Set(getDb().prepare("PRAGMA table_info(call_records)").all().map((row) => row.name));
  assert.ok(cols.has("review_note"));
  assert.ok(cols.has("review_lessons"));
  assert.ok(cols.has("reviewed_at"));
});
