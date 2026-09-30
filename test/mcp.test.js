import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { resetDatabase } from "../src/db.js";
import { app } from "../src/server.js";
import { buildRealtimeSession } from "../src/realtime.js";
import { resetStore } from "../src/store.js";

test.beforeEach(() => {
  resetDatabase();
  resetStore();
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function startStreamable() {
  const seen = [];
  let session = "";
  const server = http.createServer(async (req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    const message = await readBody(req);
    if (!message?.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === "initialize") {
      session = "sess-1";
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": session,
      });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "desk-mcp", version: "1.0.0" },
        },
      }));
      return;
    }
    if (req.headers["mcp-session-id"] !== session) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "missing session" } }));
      return;
    }
    seen.push({
      method: message.method,
      authorization: req.headers.authorization || "",
      params: message.params || {},
    });
    if (message.method === "tools/list") {
      const cursor = message.params?.cursor;
      const result = cursor
        ? { tools: [{ name: "salon.lookup", description: "Look up a salon note.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] }
        : {
          tools: [{ name: "get_note", description: "Read a note.", inputSchema: { type: "object", properties: {} } }],
          nextCursor: "p2",
        };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      return;
    }
    if (message.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `note for ${message.params.arguments?.name || "someone"}` }] },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "unknown method" } }));
  });
  return { server, seen };
}

function startSse() {
  let sse = null;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sse = res;
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (req.method === "POST" && req.url === "/messages") {
      const message = await readBody(req);
      res.writeHead(202);
      res.end();
      if (!message?.id || !sse) return;
      let result = {};
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sse-mcp", version: "0" },
        };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "ping", description: "Ping the desk.", inputSchema: { type: "object", properties: {} } }] };
      }
      sse.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
      return;
    }
    res.writeHead(405);
    res.end("use sse");
  });
  return server;
}

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

test("streamable MCP tools are saved, toggled, and called by the realtime session", async () => {
  const mcp = startStreamable();
  const port = await listen(mcp.server);
  try {
    await withServer(async (base) => {
      const bad = await fetch(`${base}/api/mcp/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "ftp://example.com/mcp" }),
      });
      assert.equal(bad.status, 400);

      const connected = await fetch(`${base}/api/mcp/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, token: "secret-token" }),
      });
      const body = await connected.json();
      assert.equal(connected.status, 200);
      assert.equal(body.mcp.connected, true);
      assert.equal(body.mcp.serverName, "desk-mcp");
      assert.equal(body.mcp.hasToken, true);
      assert.equal(JSON.stringify(body).includes("secret-token"), false);
      assert.deepEqual(body.mcp.tools.map((tool) => tool.name).sort(), ["get_note", "salon.lookup"]);
      const lookup = body.mcp.tools.find((tool) => tool.name === "salon.lookup");
      assert.equal(lookup.alias, "salon_lookup");
      assert.match(lookup.parameterSummary, /name\*/);

      const session = buildRealtimeSession("gpt-realtime-2.1", "en");
      assert.ok(session.tools.some((tool) => tool.name === "salon_lookup" && tool.type === "function"));
      assert.ok(session.tools.some((tool) => tool.name === "get_note"));

      const disabled = await fetch(`${base}/api/mcp/tools/${encodeURIComponent("salon.lookup")}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(disabled.status, 200);
      assert.equal(buildRealtimeSession("gpt-realtime-2.1", "en").tools.some((tool) => tool.name === "salon_lookup"), false);

      const { call } = await fetch(`${base}/api/calls`, { method: "POST" }).then((response) => response.json());
      const outcome = await fetch(`${base}/api/realtime/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: call.id, name: "get_note", arguments: JSON.stringify({ name: "Ada" }) }),
      });
      const result = await outcome.json();
      assert.equal(outcome.status, 200);
      assert.equal(result.ok, true);
      assert.match(result.result.text, /Ada/);
      assert.ok(mcp.seen.some((entry) => entry.method === "tools/call" && entry.params.name === "get_note"));
      assert.ok(mcp.seen.some((entry) => entry.authorization === "Bearer secret-token"));

      const state = await fetch(`${base}/api/state`).then((response) => response.json());
      assert.equal(state.mcp.hasToken, true);
      assert.equal(JSON.stringify(state).includes("secret-token"), false);
      assert.ok(state.toolCalls.some((item) => item.name === "get_note" && item.group === "mcp" && item.ok));

      const disconnected = await fetch(`${base}/api/mcp/disconnect`, { method: "POST" });
      const after = await disconnected.json();
      assert.equal(after.mcp.connected, false);
      assert.equal(after.mcp.tools.length, 0);
      assert.equal(buildRealtimeSession("gpt-realtime-2.1", "en").tools.length, 0);
    });
  } finally {
    mcp.server.closeAllConnections?.();
    await new Promise((resolve) => mcp.server.close(resolve));
  }
});

test("an SSE MCP server is used when streamable HTTP is refused", async () => {
  const mcp = startSse();
  const port = await listen(mcp);
  try {
    await withServer(async (base) => {
      const connected = await fetch(`${base}/api/mcp/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${port}/sse` }),
      });
      const body = await connected.json();
      assert.equal(connected.status, 200, JSON.stringify(body));
      assert.equal(body.mcp.serverName, "sse-mcp");
      assert.equal(body.mcp.tools[0].name, "ping");
      assert.equal(body.mcp.hasToken, false);
      await fetch(`${base}/api/mcp/disconnect`, { method: "POST" });
    });
  } finally {
    mcp.closeAllConnections?.();
    await new Promise((resolve) => mcp.close(resolve));
  }
});
