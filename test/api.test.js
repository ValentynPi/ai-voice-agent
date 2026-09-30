import assert from "node:assert/strict";
import test from "node:test";
import { resetDatabase } from "../src/db.js";
import { app } from "../src/server.js";
import { resetStore } from "../src/store.js";

test.beforeEach(() => {
  resetDatabase();
});

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
    const healthBody = await health.json();
    assert.equal(healthBody.status, "online");
    assert.equal(healthBody.database, "sqlite");

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /Maison Sol/);
    assert.match(homeHtml, /marin/);
    assert.match(homeHtml, /Voice Desk/);

    const dashboard = await fetch(`${base}/dashboard`);
    assert.equal(dashboard.status, 200);
    const html = await dashboard.text();
    assert.match(html, /MCP tools/);
    assert.match(html, /mcpUrl/);
    assert.match(html, /Security/);
    assert.doesNotMatch(html, /Add a mock tool/);
    assert.doesNotMatch(html, /id="toolGrid"/);

    const tools = await fetch(`${base}/tools`);
    assert.equal(tools.status, 200);
    assert.match(await tools.text(), /mcpUrl/);

    const pages = [
      ["/agents", /Agents/],
      ["/history", /Call history/],
      ["/knowledge", /Knowledge base/],
      ["/analytics", /Analytics/],
      ["/phone-numbers", /Twilio/],
      ["/settings", /Settings/],
      ["/agents/agt_maison_sol", /Test call/],
      ["/agents/agt_maison_sol/test", /Start call/],
    ];
    for (const [path, needle] of pages) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), needle, path);
    }
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
    assert.equal(state.mcp.connected, false);
    assert.equal(state.catalog, undefined);

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
