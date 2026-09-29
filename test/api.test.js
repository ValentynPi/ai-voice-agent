import assert from "node:assert/strict";
import test from "node:test";
import { app } from "../src/server.js";
import { resetStore } from "../src/store.js";

async function withServer(fn) {
  resetStore();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("pages and health respond", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "online");

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Maison Sol/);

    const dashboard = await fetch(`${base}/dashboard`);
    assert.equal(dashboard.status, 200);
    const html = await dashboard.text();
    assert.match(html, /MCP tools/);
    assert.match(html, /Security/);
  });
});

test("chat updates dashboard state", async () => {
  await withServer(async (base) => {
    const started = await fetch(`${base}/api/calls`, { method: "POST" });
    const { call } = await started.json();
    assert.equal(started.status, 201);

    const turn = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId: call.id, text: "Look up Lucía Ferrer", lang: "en" }),
    });
    const body = await turn.json();
    assert.equal(turn.status, 200);
    assert.match(body.reply, /Lucía Ferrer/);
    assert.equal(body.tools[0].name, "lookup_customer");

    const state = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.equal(state.status, "online");
    assert.equal(state.activeCalls, 1);
    assert.equal(state.callsToday, 1);
    assert.match(state.conversation.messages.at(-1).text, /ammonia/i);
    assert.ok(state.toolCalls.some((item) => item.name === "lookup_customer" && item.decision === "allow"));
    assert.ok(state.securityEvents.some((item) => item.decision === "allow" && item.kind === "tool"));
    assert.ok(state.catalog.orders.some((order) => order.id === "ORD-1042"));

    const ended = await fetch(`${base}/api/calls/${call.id}/end`, { method: "POST" });
    assert.equal(ended.status, 200);
    const after = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.equal(after.activeCalls, 0);
  });
});

test("refuses a closed call", async () => {
  await withServer(async (base) => {
    const { call } = await fetch(`${base}/api/calls`, { method: "POST" }).then((response) => response.json());
    await fetch(`${base}/api/calls/${call.id}/end`, { method: "POST" });
    const turn = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId: call.id, text: "Hello", lang: "en" }),
    });
    assert.equal(turn.status, 409);
  });
});
