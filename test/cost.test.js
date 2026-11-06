// Cost guards for a Realtime voice call. Offline only: no OpenAI requests.
import assert from "node:assert/strict";
import test from "node:test";
import { compactRealtimeTool, compactToolOutput } from "../src/mcp/compact.js";
import {
  REALTIME_MAX_OUTPUT_TOKENS,
  botTaskLine,
  buildRealtimeSession,
  compactModelNotes,
  greetingEvent,
  nextSessionAttempt,
  receptionistInstructions,
} from "../src/realtime.js";
import {
  MAX_CALL_MS,
  SILENCE_HANGUP_MS,
  callerReplyEvent,
  createCallBudget,
  createResponseGate,
  handleCallerTurn,
  toCachedResponse,
  toolFillerEvent,
  toolFollowUpEvent,
} from "../public/js/realtime-turn.js";
import { realtimeAccountFailure, realtimeEventFailure } from "../public/js/voice-failure.js";
import { DEFAULT_REVIEW_MODEL, realCallerTurns, reviewCandidates, reviewEndedCall } from "../src/call-review.js";
import { DEMO_ACCOUNT_ID } from "../src/accounts.js";
import { resetDatabase } from "../src/db.js";
import { createAgent } from "../src/desk.js";
import { appendMessage, endCall, getCall, resetStore, startCall } from "../src/store.js";

const WEATHER_PROMPT = "You are Weather, a phone weather agent. Your mission is the weather: tell callers today's conditions and short forecasts for the places they name. Every number comes from your live weather lookup.";
const weatherAgent = { id: "agt_w", name: "Weather", systemPrompt: WEATHER_PROMPT, greeting: "Hi, I am Weather.", enabledTools: null };

const VERBOSE_TOOL = {
  type: "function",
  name: "openmeteo_get_forecast",
  description: "Weather forecast for coordinates: hourly and/or daily variables for up to 16 days ahead. Use past_days instead of the archive for recent dates, since the archive lags by ~5 days. Returns per-timestamp records with a time field (e.g., 2026-10-21) plus one key per variable. A wide window spills to a DataCanvas. At least one of current_variables, hourly_variables, or daily_variables is required.",
  parameters: {
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: {
      latitude: { type: "number", minimum: -90, maximum: 90, description: "Latitude in decimal degrees (e.g., 47.6062 for Seattle). Use search to resolve a place name." },
      current_variables: { type: "array", maxItems: 50, items: { type: "string" }, description: "Variables for the current instant (e.g., [\"temperature_2m\"]). Uses 15-minute data so it answers what it is doing right now. Takes hourly names." },
      temperature_unit: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius", description: "Temperature unit. Default celsius." },
      start_date: { type: "string", pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26])-02-29|\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]))$", description: "Start date." },
    },
    required: ["latitude"],
  },
};

test("tool schemas are compacted but keep the contract", () => {
  const small = compactRealtimeTool(VERBOSE_TOOL);
  assert.equal(small.name, VERBOSE_TOOL.name);
  assert.deepEqual(small.parameters.required, ["latitude"]);
  assert.deepEqual(small.parameters.properties.temperature_unit.enum, ["celsius", "fahrenheit"]);
  assert.equal(small.parameters.properties.latitude.minimum, -90);
  assert.match(small.description, /^Weather forecast for coordinates/);
  assert.match(small.description, /At least one of current_variables, hourly_variables, or daily_variables is required/);
  assert.doesNotMatch(small.description, /DataCanvas|archive lags/);
  assert.equal(small.parameters.$schema, undefined);
  assert.equal(small.parameters.properties.start_date.pattern, undefined);
  assert.equal(small.parameters.properties.temperature_unit.default, undefined);
  assert.equal(small.parameters.properties.latitude.description, "Latitude in decimal degrees (e.g., 47.6062 for Seattle).");
  assert.ok(JSON.stringify(small).length < JSON.stringify(VERBOSE_TOOL).length * 0.6);
});

test("tool output sent to the model is the spoken-ready text only", () => {
  const presented = {
    text: "Place: Castellon, Spain. Current conditions: 19 °C, partly cloudy.",
    isError: false,
    content: [{ type: "text", text: "Place: Castellon, Spain. Current conditions: 19 °C, partly cloudy." }],
    structured: { results: [{ name: "Castellon", latitude: 39.98, longitude: -0.05, population: 180000 }] },
  };
  assert.deepEqual(compactToolOutput(presented), { text: presented.text });
  assert.deepEqual(compactToolOutput({ text: "Error: bad", isError: true }), { error: "Error: bad" });
  assert.deepEqual(compactToolOutput({ error: "timeout" }), { error: "timeout" });
  assert.ok(compactToolOutput({ text: "x".repeat(5000) }).text.length <= 1201);
  assert.match(compactToolOutput({ structured: { a: 1 } }).data, /"a":1/);
});

test("per-reply nudges never replace the cached session instructions", () => {
  const reply = callerReplyEvent("Яка погода в Кастельйоні?", "uk");
  const sent = toCachedResponse(reply, { botTask: botTaskLine(weatherAgent) });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "conversation.item.create");
  assert.equal(sent[0].item.role, "system");
  const note = sent[0].item.content[0].text;
  assert.match(note, /^For this reply only: Reply ONLY in Ukrainian\./);
  assert.match(note, /Stay on: the weather/);
  assert.match(note, /Native literary Ukrainian accent, not Russian; numbers as words\./);
  // +~15 tokens for the accent hint; still one short line.
  assert.ok(note.length < 240, `note stays one line (${note.length})`);
  assert.equal(sent[1].type, "response.create");
  assert.equal(sent[1].response.instructions, undefined, "session instructions apply (cached)");
  assert.equal(sent[1].response.tool_choice, "auto");
  // Non-response events pass through untouched.
  const del = { type: "conversation.item.delete", item_id: "x" };
  assert.deepEqual(toCachedResponse(del), [del]);
  // The greeting keeps its own wording, no Bot-task suffix.
  const greet = toCachedResponse(greetingEvent("en", weatherAgent), { botTask: "weather" });
  assert.match(greet[0].item.content[0].text, /Detect which language/);
  assert.doesNotMatch(greet[0].item.content[0].text, /Stay on:/);
  assert.equal(greet[1].response.tool_choice, "none");
});

test("tool follow-up and filler deltas are short; result rules live in the session", () => {
  const ok = toolFollowUpEvent("weather", false, "Яка погода в Кастельйоні?", "uk", { allowMore: true });
  assert.match(ok.response.instructions, /^Reply ONLY in Ukrainian\. Native literary Ukrainian accent, not Russian; numbers as words\. Speak the tool result/);
  assert.match(ok.response.instructions, /call the weather lookup first/);
  assert.ok(ok.response.instructions.length < 230);
  const failed = toolFollowUpEvent("weather", true, "Яка погода?", "uk");
  assert.match(failed.response.instructions, /tool failed, timed out, or is missing/);
  assert.equal(failed.response.tool_choice, "none");
  assert.ok(toolFillerEvent("Яка погода?", "uk").response.instructions.length < 80);
  const session = receptionistInstructions("en", weatherAgent, { toolCount: 2 });
  assert.match(session, /If a result only identifies the place, call the weather or forecast lookup next/);
  assert.match(session, /airport station counts as that city/);
});

test("handleCallerTurn reply stays language-first and tiny (payload snapshot)", () => {
  const gate = createResponseGate();
  gate.botTask = botTaskLine(weatherAgent);
  const turn = handleCallerTurn(gate, "Що ти вмієш?", { itemId: "i1" });
  const wire = turn.send.flatMap((event) => toCachedResponse(event, { botTask: gate.botTask }));
  assert.deepEqual(wire.map((e) => e.type), ["conversation.item.create", "response.create"]);
  assert.equal(
    wire[0].item.content[0].text,
    "For this reply only: Reply ONLY in Ukrainian. Native literary Ukrainian accent, not Russian; numbers as words. Answer their latest turn in one or two short sentences; don't ask them to repeat. Stay on: the weather.",
  );
});

test("session caps output and history; a model that rejects the caps still connects", () => {
  const session = buildRealtimeSession("gpt-realtime-2.1", "en", weatherAgent);
  assert.equal(session.max_output_tokens, REALTIME_MAX_OUTPUT_TOKENS);
  assert.equal(session.truncation.type, "retention_ratio");
  assert.ok(session.truncation.token_limits.post_instructions >= 2000);
  const next = nextSessionAttempt({ transcription: "multilingual", reasoning: "minimal" }, 400, '{"error":{"message":"Unknown parameter: session.truncation"}}');
  assert.equal(next.dropBudget, true);
  const plain = buildRealtimeSession("gpt-realtime-2.1", "en", weatherAgent, { dropBudget: true });
  assert.equal(plain.max_output_tokens, undefined);
  assert.equal(plain.truncation, undefined);
});

test("model notes are deduped and capped", () => {
  const notes = [
    "Mission: weather. This agent gives callers current conditions and short forecasts for the places they name.",
    "",
    "Lessons:",
    "- Politely decline non-weather requests and restate you only give weather and forecasts",
    "- When asked to present work, say you only provide weather info for named places",
    "- After greeting, quickly ask which place's weather they want",
    "- When asked what you can do, say you give current weather and short forecasts for places",
    "- Politely decline non-weather tasks and restate you only provide weather info",
    "- Always answer fully in the caller’s language, including capability replies",
    "- Keep explanations of what you do to one short, clear sentence",
    "- Always answer in Russian",
  ].join("\n");
  const out = compactModelNotes(notes);
  assert.match(out, /^Mission: weather/);
  assert.doesNotMatch(out, /Lessons:/);
  assert.doesNotMatch(out, /answer in Russian/, "harmful lessons dropped");
  assert.equal((out.match(/Politely decline/g) || []).length, 1, "near-duplicates dropped");
  assert.ok(out.split("\n").filter((l) => l.startsWith("- ")).length <= 6);
  assert.ok(out.length <= 800);
});

test("call budget: 30 s of silence or 10 minutes ends the call", () => {
  let t = 0;
  const budget = createCallBudget({ now: () => t });
  t = SILENCE_HANGUP_MS - 1;
  assert.equal(budget.check(false), "");
  budget.noteActivity();
  t += SILENCE_HANGUP_MS - 1;
  assert.equal(budget.check(false), "");
  t += 1;
  assert.equal(budget.check(false), "silence");
  t += 60_000;
  assert.equal(budget.check(true), "", "agent talking or a tool running holds the silence timer");
  t = MAX_CALL_MS;
  assert.equal(budget.check(true), "max");
});

test("out-of-credits after the token minted shows the credits hint", () => {
  const credits = /out of credits/;
  assert.match(realtimeAccountFailure('{"error":{"code":"credit_balance_exhausted","message":"..."}}', 429).message, credits);
  assert.match(realtimeEventFailure({ type: "error", error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } }).message, credits);
  assert.match(realtimeEventFailure({
    type: "response.done",
    response: { status: "failed", status_details: { type: "failed", error: { type: "insufficient_quota", code: "insufficient_quota" } } },
  }).message, credits);
  assert.match(realtimeAccountFailure("", 429).message, /rate-limiting/);
  assert.match(realtimeAccountFailure('{"error":{"code":"invalid_api_key"}}', 401).message, /revoked/);
  assert.equal(realtimeEventFailure({ type: "response.done", response: { status: "cancelled" } }), null);
  assert.equal(realtimeEventFailure({ type: "error", error: { message: "Cancellation failed: no active response found" } }), null);
});

test("post-call review: cheap model, and no API call without real caller turns", async () => {
  delete process.env.OPENAI_REVIEW_MODEL;
  assert.equal(DEFAULT_REVIEW_MODEL, "gpt-4o-mini");
  assert.deepEqual(reviewCandidates(), ["gpt-4o-mini", "gpt-4.1-mini"]);
  assert.equal(realCallerTurns([{ role: "user", text: "Продолжение следует..." }, { role: "user", text: "Яка погода в Кастельйоні?" }, { role: "assistant", text: "Hi" }]).length, 1);

  resetDatabase();
  resetStore();
  process.env.OPENAI_API_KEY = "test-not-a-real-key";
  process.env.CALL_REVIEW_ALLOW_MODEL = "1";
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const agent = createAgent({ name: "Weather Cost", systemPrompt: WEATHER_PROMPT, greeting: "Hi." }, DEMO_ACCOUNT_ID);
    const noise = startCall({ source: "browser", agentId: agent.id, agentName: agent.name, accountId: DEMO_ACCOUNT_ID });
    appendMessage(noise.id, { role: "assistant", text: "Hi, I am Weather." });
    appendMessage(noise.id, { role: "user", text: "Субтитры сделал DimaTorzok" });
    const noiseLive = getCall(noise.id);
    endCall(noise.id, "client");
    await reviewEndedCall(noiseLive);
    assert.equal(seen.length, 0, "no model call for a call with no real caller turn");

    const real = startCall({ source: "browser", agentId: agent.id, agentName: agent.name, accountId: DEMO_ACCOUNT_ID });
    appendMessage(real.id, { role: "user", text: "Яка погода в Кастельйоні?" });
    appendMessage(real.id, { role: "assistant", text: "У Кастельйоні зараз 19 градусів." });
    const realLive = getCall(real.id);
    endCall(real.id, "client");
    await reviewEndedCall(realLive);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CALL_REVIEW_ALLOW_MODEL;
  }
});

test("accent: per-reply hint is native-pronunciation, English gets none; session has the full rule", async () => {
  const { pronunciationHint } = await import("../public/js/caller-language.js");
  assert.equal(pronunciationHint("en"), "");
  assert.equal(pronunciationHint(""), "");
  assert.match(pronunciationHint("uk"), /literary Ukrainian/);
  assert.match(pronunciationHint("ru"), /^Native Russian accent, not English; numbers as words\.$/);
  assert.match(pronunciationHint("es"), /Native Spanish accent/);
  for (const code of ["uk", "ru", "es", "fr"]) assert.ok(pronunciationHint(code).length <= 70, code);
  const session = receptionistInstructions("en", weatherAgent, { toolCount: 2 });
  assert.match(session, /PRONUNCIATION: speak like a native speaker of the reply language/);
  assert.match(session, /standard literary Ukrainian, not Russian-accented/);
  assert.match(session, /двадцять градусів/);
  assert.match(session, /numbers, temperatures, units, and dates as words/);
});

test("Hebrew: detection, per-reply note, transcription, native accent", async () => {
  const lang = await import("../public/js/caller-language.js");
  const turn = await import("../public/js/realtime-turn.js");
  assert.equal(lang.detectCallerLanguage("מה מזג האוויר היום?"), "he");
  assert.equal(lang.detectCallerLanguage("שָׁלוֹם, מָה שְׁלוֹמְךָ?"), "he", "niqqud");
  assert.equal(lang.isClearLanguageTurn("שָׁלוֹם, מָה שְׁלוֹמְךָ?"), true);
  assert.equal(lang.detectCallerLanguage("מה מזג האוויר בקסטיון?"), "he");
  assert.equal(lang.detectCallerLanguage("ما هو الطقس اليوم؟"), "ar", "Arabic is not Hebrew");
  assert.equal(lang.detectCallerLanguage("What is the weather today in שלום?"), "en", "one Hebrew word in English is not Hebrew");
  assert.notEqual(lang.detectCallerLanguage("Що ти вмієш?"), "he");
  assert.equal(lang.resolveReplyLanguage("uk", "מה מזג האוויר היום?"), "he");
  assert.equal(lang.resolveReplyLanguage("he", "Castellón"), "he", "a place name is not a switch");
  assert.equal(lang.resolveReplyLanguage("he", "כן"), "he");
  assert.ok(lang.inputTranscription("he").languages[0] === "he");
  assert.ok(lang.inputTranscription("").languages.includes("he"));
  assert.equal(turn.shortLanguageLine("he"), "Reply ONLY in Hebrew. Native modern Israeli Hebrew accent and stress, not English; numbers as Hebrew words.");
  const sent = toCachedResponse(callerReplyEvent("מה מזג האוויר היום?", "he"), { botTask: "the weather" });
  assert.match(sent[0].item.content[0].text, /^For this reply only: Reply ONLY in Hebrew\. Native modern Israeli Hebrew/);
  assert.ok(sent[0].item.content[0].text.length < 260);
  assert.equal(turn.stillLookingLine("he"), "עוד רגע, בודקים.");
  assert.match(turn.silenceFallbackEvent("שלום שלום", "he").response.instructions, /לא שמעתי/);
  assert.match(lang.spokenFailure("weather", "מזג האוויר", "he"), /אי אפשר/);
  assert.equal(turn.replyInLanguage("היום עשרים מעלות", "he"), true);
  const session = receptionistInstructions("en", weatherAgent, { toolCount: 2 });
  assert.match(session, /modern Israeli Hebrew with correct stress/);
  assert.match(session, /עשרים מעלות/);
});
