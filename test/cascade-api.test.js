// Cascade engine wiring: per-agent setting, call start, ticket, browser socket.
// Providers are mocked; no network.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { resetDatabase } from "../src/db.js";
import { app } from "../src/server.js";
import { getCall, resetStore } from "../src/store.js";
import { handleBrowserCascade, issueCascadeTicket, redeemCascadeTicket } from "../src/cascade/transport.js";

const ENV_KEYS = ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "CASCADE_STT", "CASCADE_TTS", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "DEEPGRAM_API_KEY"];
let saved = {};
test.beforeEach(() => {
  resetDatabase();
  resetStore();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
test.afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function withServer(fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

async function makeAgent(base, extra = {}) {
  const created = await json(await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Weather", systemPrompt: "You are a weather line. Your mission is the weather.", greeting: "Вітаю! Яке місто вас цікавить?", ...extra }),
  }));
  assert.equal(created.status, 201);
  return created.body.agent;
}

test("voice engine is a saved per-agent setting; default stays OpenAI Realtime", async () => {
  await withServer(async (base) => {
    const agent = await makeAgent(base);
    assert.equal(agent.voiceEngine, "realtime");
    const patched = await json(await fetch(`${base}/api/agents/${agent.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceEngine: "cascade" }) }));
    assert.equal(patched.body.agent.voiceEngine, "cascade");
    const bad = await fetch(`${base}/api/agents/${agent.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceEngine: "nope" }) });
    assert.equal(bad.status, 400);
    const detail = await json(await fetch(`${base}/api/agents/${agent.id}`));
    assert.equal(detail.body.agent.voiceEngine, "cascade");
    assert.equal(detail.body.cascade.ready, false);
    assert.equal(detail.body.cascade.label, "Needs OpenAI and ElevenLabs keys");
    assert.deepEqual(detail.body.cascade.missing.map((m) => m.env), ["OPENAI_API_KEY", "ELEVENLABS_API_KEY"]);
    const page = await (await fetch(`${base}/agents/${agent.id}`)).text();
    assert.match(page, /id="voiceEngine"/);
  });
});

test("a cascade agent without keys falls back to Realtime and says which key is missing", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  await withServer(async (base) => {
    const agent = await makeAgent(base, { voiceEngine: "cascade" });
    const call = await json(await fetch(`${base}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) }));
    assert.equal(call.status, 201);
    assert.equal(call.body.engine, "realtime");
    assert.equal(call.body.wantedEngine, "cascade");
    assert.equal(call.body.cascade.label, "Needs ElevenLabs key");
    const session = await json(await fetch(`${base}/api/cascade/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: call.body.call.id }) }));
    assert.equal(session.status, 503);
    assert.equal(session.body.code, "cascade_not_ready");
    assert.deepEqual(session.body.missing, ["ELEVENLABS_API_KEY"]);
  });
});

test("existing Realtime agents are untouched: no cascade fields change their call", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ELEVENLABS_API_KEY = "el-test";
  await withServer(async (base) => {
    const agent = await makeAgent(base);
    const call = await json(await fetch(`${base}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) }));
    assert.equal(call.body.engine, "realtime");
    assert.equal(call.body.cascade, null);
    assert.equal(call.body.call.voice, agent.voice);
  });
});

test("with keys, a cascade call gets a one-time ticket and no secrets", async () => {
  process.env.OPENAI_API_KEY = "sk-secret-value";
  process.env.ELEVENLABS_API_KEY = "el-secret-value";
  await withServer(async (base) => {
    const agent = await makeAgent(base, { voiceEngine: "cascade" });
    const call = await json(await fetch(`${base}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) }));
    assert.equal(call.body.engine, "cascade");
    assert.equal(call.body.call.voice, "cascade:elevenlabs");
    const session = await fetch(`${base}/api/cascade/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: call.body.call.id }) });
    const raw = await session.text();
    assert.equal(session.status, 200);
    assert.doesNotMatch(raw, /secret-value/);
    const body = JSON.parse(raw);
    assert.equal(body.wsPath, "/api/cascade/ws");
    assert.equal(body.stt, "elevenlabs");
    assert.equal(redeemCascadeTicket(body.ticket), call.body.call.id);
    assert.equal(redeemCascadeTicket(body.ticket), null, "tickets are single use");
    const listed = await (await fetch(`${base}/api/agents`)).text();
    assert.doesNotMatch(listed, /secret-value/);
  });
});

test("the cascade socket rejects a missing or used ticket", async () => {
  process.env.OPENAI_API_KEY = "sk";
  process.env.ELEVENLABS_API_KEY = "el";
  await withServer(async (base) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/cascade/ws?ticket=nope`);
    const first = await new Promise((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(String(data))));
      ws.once("error", reject);
    });
    assert.equal(first.type, "error");
    assert.equal(first.code, "cascade_ticket");
  });
});

class FakeClientWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.binary = []; this.json = []; }
  send(data, opts) { if (opts?.binary) this.binary.push(data); else this.json.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit("close"); }
}

test("browser cascade socket: greeting audio down, mic audio up to STT, transcripts recorded", async () => {
  process.env.OPENAI_API_KEY = "sk";
  process.env.ELEVENLABS_API_KEY = "el";
  await withServer(async (base) => {
    const agent = await makeAgent(base, { voiceEngine: "cascade" });
    const call = await json(await fetch(`${base}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) }));
    const callId = call.body.call.id;
    const ticket = issueCascadeTicket(callId);
    const ws = new FakeClientWs();
    let stt = null;
    const heard = [];
    const ttsLangs = [];
    const providers = {
      openStt: (opts) => { stt = opts; return { ready: Promise.resolve(), send: (b) => heard.push(b.length), close() {} }; },
      openTts: ({ language, onAudio }) => {
        ttsLangs.push(language);
        let done;
        const p = new Promise((r) => { done = r; });
        return { done: p, send: () => onAudio(Buffer.alloc(640)), end: () => done(), abort: () => done() };
      },
    };
    const llm = async function* () { yield { type: "text", delta: "Зараз двадцять градусів." }; };
    const session = await handleBrowserCascade(ws, new URL(`http://x/api/cascade/ws?ticket=${ticket}`), { providers, llm, tickMs: 5 });
    assert.ok(session);
    assert.equal(ttsLangs[0], "uk", "Ukrainian greeting is voiced in Ukrainian");
    assert.ok(ws.binary.length >= 1);
    assert.ok(ws.json.some((m) => m.type === "ready"));
    ws.emit("message", Buffer.alloc(1280), true);
    assert.deepEqual(heard, [1280]);
    stt.onCommitted("Яка погода в Києві?", "uk");
    await new Promise((r) => setTimeout(r, 30));
    const messages = getCall(callId).messages;
    assert.deepEqual(messages.map((m) => m.role), ["assistant", "user", "assistant"]);
    assert.equal(messages[2].text, "Зараз двадцять градусів.");
    ws.emit("message", JSON.stringify({ type: "stop" }), false);
    assert.equal(ws.readyState, 3);
  });
});

test("telephony host proxies the cascade socket to the Agents brain (calls stay on its origin)", async () => {
  const http = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { attachCascadeProxy } = await import("../src/cascade/transport.js");
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream, path: "/api/cascade/ws" });
  const seen = [];
  wss.on("connection", (socket, req) => {
    seen.push(req.url);
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const front = http.createServer();
  assert.equal(attachCascadeProxy(front, `http://127.0.0.1:${upstream.address().port}`), true);
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  try {
    const client = new WebSocket(`ws://127.0.0.1:${front.address().port}/api/cascade/ws?ticket=abc`);
    await new Promise((r, j) => { client.once("open", r); client.once("error", j); });
    client.send(Buffer.from([7, 8, 9]));
    const echoed = await new Promise((r) => client.once("message", (data) => r([...data])));
    assert.deepEqual(echoed, [7, 8, 9]);
    assert.equal(seen[0], "/api/cascade/ws?ticket=abc");
    client.close();
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => front.close(r));
    await new Promise((r) => upstream.close(r));
  }
});
