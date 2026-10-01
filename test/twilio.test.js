import assert from "node:assert/strict";
import test from "node:test";
import { resetDatabase } from "../src/db.js";
import { app } from "../src/server.js";
import { resetStore } from "../src/store.js";
import { DEMO_ACCOUNT_SID, DEMO_NUMBER_SID } from "../src/twilio/ids.js";
import { readAccount } from "../src/twilio/store.js";

const ENV_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY", "TWILIO_API_KEY_SECRET"];
let savedEnv = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  resetDatabase();
  resetStore();
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] == null) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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

function sid(prefix, seed) {
  return prefix + seed.repeat(32 / seed.length);
}

test("demo console account, numbers, calls, and webhooks share one shape", async () => {
  await withServer(async (base) => {
    const accountRes = await fetch(`${base}/api/twilio/v1/account`);
    const account = await accountRes.json();
    assert.equal(accountRes.status, 200);
    assert.equal(account.mode, "demo");
    assert.equal(account.demo, true);
    assert.equal(account.account_sid, DEMO_ACCOUNT_SID);
    assert.equal(account.auth_token_set, false);
    assert.equal(account.api_key_secret_set, false);
    assert.equal(Object.hasOwn(account, "auth_token"), false);
    assert.match(account.voice_webhook_url, /\/twilio\/voice$/);
    assert.match(account.status_callback_url, /\/twilio\/status$/);

    const numbers = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/IncomingPhoneNumbers`).then((response) => response.json());
    assert.equal(numbers.incoming_phone_numbers.length, 1);
    assert.equal(numbers.incoming_phone_numbers[0].sid, DEMO_NUMBER_SID);
    assert.equal(numbers.incoming_phone_numbers[0].phone_number, "+34964000214");
    assert.equal(numbers.incoming_phone_numbers[0].demo, true);
    assert.deepEqual(numbers.incoming_phone_numbers[0].capabilities, { voice: true, sms: false, mms: false });
    assert.equal(numbers.incoming_phone_numbers[0].voice_url, "/twilio/voice");

    const missing = await fetch(`${base}/api/twilio/v1/Accounts/${sid("AC", "ab")}/Calls`);
    assert.equal(missing.status, 404);

    const calls = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Calls`).then((response) => response.json());
    const inbound = calls.calls.find((call) => call.direction === "inbound" && call.from === "+34611222333");
    const missed = calls.calls.find((call) => call.status === "no-answer");
    assert.ok(inbound);
    assert.equal(inbound.status, "completed");
    assert.equal(inbound.duration, "86");
    assert.ok(missed);
    assert.equal(missed.direction, "outbound");

    const recordings = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Calls/${inbound.sid}/Recordings`).then((response) => response.json());
    assert.equal(recordings.recordings.length, 1);
    assert.equal(recordings.recordings[0].media_url, null);
    assert.match(recordings.recordings[0].note, /No audio file/);

    const available = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/AvailablePhoneNumbers/ES/Local?Contains=964`).then((response) => response.json());
    assert.ok(available.available_phone_numbers.length >= 1);
    assert.equal(available.available_phone_numbers.some((item) => item.phone_number === "+34964000214"), false);
    const otherCountry = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/AvailablePhoneNumbers/US/Local`).then((response) => response.json());
    assert.equal(otherCountry.available_phone_numbers.length, 0);
    assert.match(otherCountry.message, /Spain/);

    const bought = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/IncomingPhoneNumbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: available.available_phone_numbers[0].phone_number, friendly_name: "Front desk" }),
    });
    const number = await bought.json();
    assert.equal(bought.status, 201);
    assert.equal(number.demo, true);
    assert.equal(number.origin, "demo");
    assert.equal(number.friendly_name, "Front desk");
    assert.equal(JSON.stringify(number).includes("auth_token"), false);

    const duplicate = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/IncomingPhoneNumbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: number.phone_number }),
    });
    assert.equal(duplicate.status, 409);

    const invented = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/IncomingPhoneNumbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: "+34911111111" }),
    });
    assert.equal(invented.status, 400);

    const apps = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Applications`).then((response) => response.json());
    const appSid = apps.applications[0].sid;
    const updated = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Applications/${appSid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_url: "https://example.com/voice", status_callback: "/twilio/status" }),
    });
    const appBody = await updated.json();
    assert.equal(updated.status, 200);
    assert.equal(appBody.voice_url, "https://example.com/voice");
    assert.equal(appBody.status_callback, "/twilio/status");

    const callSid = sid("CA", "cd");
    const voice = await fetch(`${base}/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        CallSid: callSid,
        From: "+34600111222",
        To: "+34964000214",
        CallStatus: "ringing",
        Direction: "inbound",
        AccountSid: account.account_sid,
        AuthToken: "should-not-be-logged",
      }),
    });
    assert.equal(voice.status, 200);
    assert.match(voice.headers.get("content-type"), /xml/);
    const xml = await voice.text();
    assert.match(xml, /<Response>/);
    assert.match(xml, /<Say/);
    assert.match(xml, /Media Streams/);

    const status = await fetch(`${base}/twilio/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "not-a-real-signature" },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: "completed", CallDuration: "9", Direction: "inbound" }),
    });
    assert.equal(status.status, 204);

    const after = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Calls/${callSid}`).then((response) => response.json());
    assert.equal(after.status, "completed");
    assert.equal(after.duration, "9");
    assert.equal(after.from, "+34600111222");

    const logs = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Monitor/Events`).then((response) => response.json());
    const delivery = logs.events.find((event) => event.call_sid === callSid && event.request_url === "/twilio/voice");
    assert.ok(delivery);
    assert.equal(delivery.request_variables.AuthToken, undefined);
    assert.equal(JSON.stringify(logs).includes("should-not-be-logged"), false);
    const callback = logs.events.find((event) => event.request_url === "/twilio/status" && event.call_sid === callSid);
    assert.equal(callback.signature, "unchecked");
    assert.equal(callback.log_level, "info");

    const page = await fetch(`${base}/console/voice/calls`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Telephony/);
    assert.match(html, /Demo mode/);
    assert.match(html, /API keys/);
    assert.doesNotMatch(html, /should-not-be-logged/);
  });
});

test("stored credentials never return to the client and do not leave demo mode", async () => {
  await withServer(async (base) => {
    const token = "super-secret-auth-token";
    const secret = "another-secret-value-xx";
    const saved = await fetch(`${base}/api/twilio/v1/account/credentials`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_sid: sid("AC", "ef"),
        auth_token: token,
        api_key_sid: sid("SK", "ab"),
        api_key_secret: secret,
      }),
    });
    const body = await saved.json();
    const text = JSON.stringify(body);
    assert.equal(saved.status, 200);
    assert.equal(body.mode, "demo");
    assert.equal(body.auth_token_set, true);
    assert.equal(body.auth_token_source, "stored");
    assert.equal(body.api_key_secret_set, true);
    assert.equal(body.saved_account_sid, sid("AC", "ef"));
    assert.equal(body.api_key_sid, sid("SK", "ab"));
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(secret), false);
    assert.equal(Object.hasOwn(body, "auth_token"), false);
    assert.equal(Object.hasOwn(body, "api_key_secret"), false);

    const again = await fetch(`${base}/api/twilio/v1/account`).then((response) => response.text());
    assert.equal(again.includes(token), false);
    assert.equal(again.includes(secret), false);
    assert.equal(readAccount().auth_token, token);
    assert.equal(readAccount().api_key_secret, secret);

    const cleared = await fetch(`${base}/api/twilio/v1/account/credentials`, { method: "DELETE" }).then((response) => response.json());
    assert.equal(cleared.auth_token_set, false);
    assert.equal(cleared.mode, "demo");
    assert.equal(readAccount().auth_token, null);
  });
});

test("a browser test call is a continuous Twilio-shaped call", async () => {
  await withServer(async (base) => {
    const started = await fetch(`${base}/api/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { call } = await started.json();
    const account = await fetch(`${base}/api/twilio/v1/account`).then((response) => response.json());
    const live = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Calls`).then((response) => response.json());
    const row = live.calls.find((item) => item.local_call_id === call.id);
    assert.ok(row);
    assert.equal(row.from, "client:browser");
    assert.equal(row.to, "+34964000214");
    assert.equal(row.direction, "inbound");
    assert.equal(row.status, "in-progress");
    assert.equal(row.media, "browser-realtime");
    assert.match(row.sid, /^CA[0-9a-f]{32}$/);

    await fetch(`${base}/api/calls/${call.id}/end`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const done = await fetch(`${base}/api/twilio/v1/Accounts/${account.account_sid}/Calls/${row.sid}`).then((response) => response.json());
    assert.equal(done.status, "completed");
    assert.equal(done.sid, row.sid);
    assert.equal(done.local_call_id, call.id);
  });
});

test("connected mode lists Twilio resources and refuses an unconfirmed purchase", async () => {
  const previousFetch = global.fetch;
  const accountSid = sid("AC", "12");
  const token = "live-auth-token-value";
  process.env.TWILIO_ACCOUNT_SID = accountSid;
  process.env.TWILIO_AUTH_TOKEN = token;
  const hits = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    if (!target.includes("api.twilio.com")) return previousFetch(url, init);
    hits.push({ url: target, method: init?.method || "GET", authorization: init?.headers?.Authorization });
    if (target.includes("/IncomingPhoneNumbers.json") && init?.method === "POST") {
      return new Response(JSON.stringify({
        sid: sid("PN", "34"),
        account_sid: accountSid,
        phone_number: "+14155550100",
        friendly_name: "Live line",
        capabilities: { voice: true, sms: false, mms: false },
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (target.includes("/IncomingPhoneNumbers.json")) {
      return new Response(JSON.stringify({
        incoming_phone_numbers: [{
          sid: sid("PN", "56"),
          account_sid: accountSid,
          phone_number: "+14155550199",
          friendly_name: "From Twilio",
          voice_url: "https://example.com/voice",
          capabilities: { voice: true, sms: true, mms: false },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.includes("/Calls.json")) {
      return new Response(JSON.stringify({
        calls: [{
          sid: sid("CA", "78"),
          account_sid: accountSid,
          from: "+14155550000",
          to: "+14155550199",
          status: "completed",
          direction: "outbound-api",
          duration: "3",
          start_time: "Thu, 01 Oct 2026 12:00:00 +0000",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
  };

  try {
    await withServer(async (base) => {
      const account = await fetch(`${base}/api/twilio/v1/account`).then((response) => response.json());
      assert.equal(account.mode, "connected");
      assert.equal(account.account_sid, accountSid);
      assert.equal(JSON.stringify(account).includes(token), false);

      const numbers = await fetch(`${base}/api/twilio/v1/Accounts/${accountSid}/IncomingPhoneNumbers`).then((response) => response.json());
      assert.equal(numbers.incoming_phone_numbers.length, 1);
      assert.equal(numbers.incoming_phone_numbers[0].phone_number, "+14155550199");
      assert.equal(numbers.incoming_phone_numbers[0].demo, false);
      assert.equal(numbers.incoming_phone_numbers.some((item) => item.phone_number === "+34964000214"), false);

      const calls = await fetch(`${base}/api/twilio/v1/Accounts/${accountSid}/Calls`).then((response) => response.json());
      assert.ok(calls.calls.some((call) => call.direction === "outbound-api" && call.demo === false));

      const blocked = await fetch(`${base}/api/twilio/v1/Accounts/${accountSid}/IncomingPhoneNumbers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: "+14155550100", friendly_name: "Live line" }),
      });
      assert.equal(blocked.status, 400);
      assert.equal(hits.some((hit) => hit.method === "POST"), false);

      const bought = await fetch(`${base}/api/twilio/v1/Accounts/${accountSid}/IncomingPhoneNumbers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: "+14155550100", friendly_name: "Live line", confirm_purchase: true }),
      });
      const created = await bought.json();
      assert.equal(bought.status, 201);
      assert.equal(created.demo, false);
      assert.equal(created.phone_number, "+14155550100");
      assert.equal(JSON.stringify(created).includes(token), false);
      const post = hits.find((hit) => hit.method === "POST");
      assert.ok(post);
      assert.match(post.authorization, /^Basic /);
      const decoded = Buffer.from(post.authorization.slice(6), "base64").toString();
      assert.equal(decoded, `${accountSid}:${token}`);
    });
  } finally {
    global.fetch = previousFetch;
  }
});
