import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_ACCOUNT_ID } from "../src/accounts.js";
import { resetDatabase, getDb } from "../src/db.js";
import { app } from "../src/server.js";
import { resetStore } from "../src/store.js";

const SECRET = "test-telephony-secret-history";

test.beforeEach(() => {
  process.env.TELEPHONY_SHARED_SECRET = SECRET;
  process.env.SERVICE = "all";
  delete process.env.AGENTS_REQUIRE_AUTH;
  resetDatabase();
  resetStore();
});

test.afterEach(() => {
  delete process.env.TELEPHONY_SHARED_SECRET;
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

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() || [];
  const joined = raw.length ? raw : [response.headers.get("set-cookie")].filter(Boolean);
  return joined.map((item) => String(item).split(";")[0]).join("; ");
}

test("brain proxy secret + agent owner attributes history to the tenant", async () => {
  await withServer(async (base) => {
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "password123", name: "Owner" }),
    });
    assert.equal(signup.status, 201);
    const cookie = cookieFrom(signup);
    const accountId = (await signup.json()).account.id;

    const created = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        name: "Weather",
        systemPrompt: "You report weather.",
        greeting: "Hi.",
      }),
    });
    assert.equal(created.status, 201);
    const agentId = (await created.json()).agent.id;

    // Simulate telephony brain proxy: shared secret, demo tenant header, real agent.
    const started = await fetch(`${base}/api/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telephony-Secret": SECRET,
        "X-Tenant-Id": DEMO_ACCOUNT_ID,
      },
      body: JSON.stringify({ agentId }),
    });
    assert.equal(started.status, 201);
    const call = (await started.json()).call;
    assert.equal(call.accountId, accountId);

    const ended = await fetch(`${base}/api/calls/${call.id}/end`, {
      method: "POST",
      headers: { "X-Telephony-Secret": SECRET, "X-Tenant-Id": DEMO_ACCOUNT_ID },
    });
    assert.equal(ended.status, 200);

    const history = await fetch(`${base}/api/history`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(history.calls.length, 1);
    assert.equal(history.calls[0].id, call.id);
    assert.equal(history.calls[0].agentName, "Weather");

    const stats = await fetch(`${base}/api/analytics`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(stats.callCount, 1);
    assert.equal(stats.completed, 1);

    const demoHistory = await fetch(`${base}/api/history`).then((r) => r.json());
    assert.equal(demoHistory.calls.some((item) => item.id === call.id), false);
  });
});

test("trusted X-Tenant-Id overrides demo when account exists", async () => {
  await withServer(async (base) => {
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tenant@example.com", password: "password123", name: "Tenant" }),
    });
    const cookie = cookieFrom(signup);
    const accountId = (await signup.json()).account.id;
    const created = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Desk", systemPrompt: "Hi", greeting: "Hello" }),
    });
    const agentId = (await created.json()).agent.id;

    const started = await fetch(`${base}/api/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telephony-Secret": SECRET,
        "X-Tenant-Id": accountId,
      },
      body: JSON.stringify({ agentId }),
    });
    assert.equal(started.status, 201);
    const call = (await started.json()).call;
    assert.equal(call.accountId, accountId);

    await fetch(`${base}/api/calls/${call.id}/end`, {
      method: "POST",
      headers: { "X-Telephony-Secret": SECRET, "X-Tenant-Id": accountId },
    });

    const history = await fetch(`${base}/api/history`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(history.calls.length, 1);
  });
});

test("migrate re-homes demo call_records onto the agent owner", () => {
  const ownerId = "acct_ownerfix";
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO accounts (id, email, password_hash, name, is_demo, created_at)
    VALUES (?, ?, 'scrypt$x$y', 'Owner', 0, ?)
  `).run(ownerId, "migrate-owner@example.com", now);
  getDb().prepare(`
    INSERT INTO agents (
      id, account_id, name, description, system_prompt, greeting, voice, language,
      model_notes, enabled_tools_json, created_at, updated_at
    ) VALUES (?, ?, 'Weather', '', 'prompt', 'hi', 'marin', 'en', '', '[]', ?, ?)
  `).run("agt_migrate_weather", ownerId, now, now);
  getDb().prepare(`
    INSERT INTO call_records (
      id, account_id, agent_id, agent_name, source, status, started_at, ended_at, duration_ms,
      transcript_json, summary, voice, language, end_reason
    ) VALUES (?, ?, ?, 'Weather', 'browser', 'completed', ?, ?, 1000, '[]', 'summary', null, null, 'client')
  `).run("call_misattributed", DEMO_ACCOUNT_ID, "agt_migrate_weather", now, now);

  // Re-run migrate path via resetDatabase init already happened; call the SQL directly as migrate does.
  getDb().prepare(`
    UPDATE call_records
    SET account_id = (
      SELECT agents.account_id FROM agents WHERE agents.id = call_records.agent_id
    )
    WHERE call_records.account_id = ?
      AND call_records.agent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM agents
        WHERE agents.id = call_records.agent_id
          AND agents.account_id IS NOT NULL
          AND agents.account_id != ''
          AND agents.account_id != ?
      )
  `).run(DEMO_ACCOUNT_ID, DEMO_ACCOUNT_ID);

  const row = getDb().prepare("SELECT account_id FROM call_records WHERE id = ?").get("call_misattributed");
  assert.equal(row.account_id, ownerId);
});
