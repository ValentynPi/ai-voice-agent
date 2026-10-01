import { getDb } from "../db.js";
import { cleanE164, cleanText, cleanWebhookUrl, httpError } from "./http.js";
import {
  DEMO_INVENTORY,
  isSid,
  randomSid,
  stableSid,
} from "./ids.js";

const CALL_STATUSES = new Set([
  "queued",
  "ringing",
  "in-progress",
  "completed",
  "failed",
  "busy",
  "no-answer",
  "canceled",
]);

function accountRow() {
  return getDb().prepare(`
    SELECT account_sid, friendly_name, saved_account_sid, auth_token, api_key_sid, api_key_secret,
           date_created, updated_at
    FROM twilio_account WHERE id = 1
  `).get();
}

export function readAccount() {
  const row = accountRow();
  if (!row) throw httpError(500, "Telephony account is not initialized");
  return row;
}

export function demoAccountSid() {
  return readAccount().account_sid;
}

function capabilities(row) {
  try {
    const parsed = JSON.parse(row.capabilities_json || "{}");
    return {
      voice: Boolean(parsed.voice),
      sms: Boolean(parsed.sms),
      mms: Boolean(parsed.mms),
    };
  } catch {
    return { voice: true, sms: false, mms: false };
  }
}

function numberUri(accountSid, sid) {
  return `/api/twilio/v1/Accounts/${accountSid}/IncomingPhoneNumbers/${sid}`;
}

export function mapNumber(row) {
  return {
    sid: row.sid,
    account_sid: row.account_sid,
    friendly_name: row.friendly_name,
    phone_number: row.phone_number,
    voice_url: row.voice_url || "",
    voice_method: row.voice_method || "POST",
    voice_fallback_url: row.voice_fallback_url || null,
    voice_fallback_method: "POST",
    status_callback: row.status_callback || "",
    status_callback_method: row.status_callback_method || "POST",
    sms_url: row.sms_url || null,
    sms_method: row.sms_method || "POST",
    capabilities: capabilities(row),
    status: row.status || "in-use",
    api_version: "2010-04-01",
    beta: false,
    origin: row.demo ? "demo" : "twilio",
    demo: Boolean(row.demo),
    date_created: row.date_created,
    date_updated: row.date_updated,
    uri: numberUri(row.account_sid, row.sid),
  };
}

function mapCall(row) {
  const accountSid = row.account_sid;
  return {
    sid: row.sid,
    account_sid: accountSid,
    parent_call_sid: row.parent_call_sid || null,
    to: row.to_number,
    from: row.from_number,
    phone_number_sid: row.phone_number_sid || null,
    status: row.status,
    start_time: row.start_time,
    end_time: row.end_time,
    duration: row.duration == null ? null : String(row.duration),
    price: row.price || null,
    price_unit: "USD",
    direction: row.direction,
    answered_by: null,
    api_version: "2010-04-01",
    forwarded_from: null,
    caller_name: null,
    recording_url: row.recording_url || null,
    recording_sid: row.recording_sid || null,
    demo: Boolean(row.demo),
    media: row.media || null,
    local_call_id: row.local_call_id || null,
    annotation: row.annotation || "",
    date_created: row.date_created,
    date_updated: row.date_updated,
    uri: `/api/twilio/v1/Accounts/${accountSid}/Calls/${row.sid}`,
    subresource_uris: {
      recordings: `/api/twilio/v1/Accounts/${accountSid}/Calls/${row.sid}/Recordings`,
    },
  };
}

function mapApp(row) {
  return {
    sid: row.sid,
    account_sid: row.account_sid,
    friendly_name: row.friendly_name,
    voice_url: row.voice_url || "",
    voice_method: row.voice_method || "POST",
    voice_fallback_url: null,
    voice_fallback_method: "POST",
    status_callback: row.status_callback || "",
    status_callback_method: row.status_callback_method || "POST",
    sms_url: row.sms_url || null,
    sms_method: row.sms_method || "POST",
    api_version: "2010-04-01",
    demo: Boolean(row.demo),
    date_created: row.date_created,
    date_updated: row.date_updated,
    uri: `/api/twilio/v1/Accounts/${row.account_sid}/Applications/${row.sid}`,
  };
}

function mapEvent(row) {
  let request = {};
  try {
    const parsed = JSON.parse(row.request_json || "{}");
    request = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    request = {};
  }
  return {
    sid: row.sid,
    account_sid: row.account_sid,
    date_created: row.date_created,
    request_method: row.request_method,
    request_url: row.request_url,
    call_sid: row.call_sid || null,
    request_variables: request,
    response_status_code: row.response_status,
    response_body: row.response_body || "",
    log_level: row.log_level,
    message: row.message,
    signature: row.signature,
    demo: true,
    uri: `/api/twilio/v1/Accounts/${row.account_sid}/Monitor/Events/${row.sid}`,
  };
}

export function listNumbers(accountSid, { phoneNumber = "", friendlyName = "" } = {}) {
  const rows = getDb().prepare(`
    SELECT * FROM twilio_numbers WHERE account_sid = ? ORDER BY date_created, phone_number
  `).all(accountSid).map(mapNumber);
  return rows.filter((row) => {
    if (phoneNumber && !row.phone_number.includes(phoneNumber.replace(/\s/g, ""))) return false;
    if (friendlyName && !row.friendly_name.toLowerCase().includes(friendlyName.toLowerCase())) return false;
    return true;
  });
}

export function getNumber(accountSid, sid) {
  const row = getDb().prepare(`
    SELECT * FROM twilio_numbers WHERE account_sid = ? AND sid = ?
  `).get(accountSid, sid);
  return row ? mapNumber(row) : null;
}

export function primaryNumber(accountSid) {
  const row = getDb().prepare(`
    SELECT * FROM twilio_numbers WHERE account_sid = ? ORDER BY date_created LIMIT 1
  `).get(accountSid);
  return row ? mapNumber(row) : null;
}

function method(value) {
  return String(value || "POST").toUpperCase() === "GET" ? "GET" : "POST";
}

export function createDemoNumber({ accountSid, phoneNumber, friendlyName, voiceUrl, statusCallback }) {
  const phone = cleanE164(phoneNumber);
  if (!phone) throw httpError(400, "phone_number must be E.164, like +34964000214");
  const known = DEMO_INVENTORY.find((item) => item.phone_number === phone);
  if (!known) {
    throw httpError(400, "That number is not in the demo inventory. Search available numbers and pick one. Demo mode does not buy from Twilio.");
  }
  const existing = getDb().prepare("SELECT sid FROM twilio_numbers WHERE phone_number = ?").get(phone);
  if (existing) throw httpError(409, "That demo number is already on this account");
  const now = new Date().toISOString();
  const sid = randomSid("PN");
  const name = cleanText(friendlyName, 64) || known.friendly_name || phone;
  const voice = voiceUrl == null ? "/twilio/voice" : cleanWebhookUrl(voiceUrl);
  const status = statusCallback == null ? "/twilio/status" : cleanWebhookUrl(statusCallback);
  getDb().prepare(`
    INSERT INTO twilio_numbers (
      sid, account_sid, phone_number, friendly_name, voice_url, voice_method, voice_fallback_url,
      status_callback, status_callback_method, sms_url, sms_method, capabilities_json, status, demo,
      date_created, date_updated
    ) VALUES (?, ?, ?, ?, ?, 'POST', NULL, ?, 'POST', NULL, 'POST', ?, 'in-use', 1, ?, ?)
  `).run(
    sid,
    accountSid,
    phone,
    name,
    voice,
    status,
    JSON.stringify({ voice: true, sms: Boolean(known.sms), mms: false }),
    now,
    now,
  );
  return getNumber(accountSid, sid);
}

export function updateDemoNumber(accountSid, sid, input) {
  const current = getNumber(accountSid, sid);
  if (!current) throw httpError(404, "The requested resource was not found");
  const now = new Date().toISOString();
  const friendly = Object.prototype.hasOwnProperty.call(input, "friendlyName")
    ? cleanText(input.friendlyName, 64)
    : current.friendly_name;
  if (!friendly) throw httpError(400, "Friendly name is required");
  const voice = Object.prototype.hasOwnProperty.call(input, "voiceUrl")
    ? cleanWebhookUrl(input.voiceUrl)
    : current.voice_url;
  const voiceMethod = Object.prototype.hasOwnProperty.call(input, "voiceMethod")
    ? method(input.voiceMethod)
    : current.voice_method;
  const status = Object.prototype.hasOwnProperty.call(input, "statusCallback")
    ? cleanWebhookUrl(input.statusCallback)
    : current.status_callback;
  const statusMethod = Object.prototype.hasOwnProperty.call(input, "statusCallbackMethod")
    ? method(input.statusCallbackMethod)
    : current.status_callback_method;
  getDb().prepare(`
    UPDATE twilio_numbers SET
      friendly_name = ?, voice_url = ?, voice_method = ?, status_callback = ?,
      status_callback_method = ?, date_updated = ?
    WHERE sid = ? AND account_sid = ?
  `).run(friendly, voice, voiceMethod, status, statusMethod, now, sid, accountSid);
  return getNumber(accountSid, sid);
}

export function listAvailable({ country, contains = "", sms }) {
  const iso = String(country || "").toUpperCase();
  if (iso !== "ES") {
    return {
      numbers: [],
      message: "Demo inventory only includes Spain (ES). Connect Twilio to search other countries. Nothing is purchased in Demo mode.",
    };
  }
  const owned = new Set(getDb().prepare("SELECT phone_number FROM twilio_numbers").all().map((row) => row.phone_number));
  const digits = String(contains || "").replace(/\D/g, "");
  const numbers = DEMO_INVENTORY.filter((item) => {
    if (owned.has(item.phone_number)) return false;
    if (digits && !item.phone_number.includes(digits)) return false;
    if (sms && !item.sms) return false;
    return true;
  }).map((item) => ({
    phone_number: item.phone_number,
    friendly_name: item.friendly_name || item.phone_number,
    locality: item.locality,
    region: item.region,
    postal_code: null,
    iso_country: "ES",
    address_requirements: "none",
    beta: false,
    capabilities: { voice: true, SMS: Boolean(item.sms), MMS: false },
    demo: true,
  }));
  return { numbers, message: numbers.length ? "" : "No demo numbers match that search." };
}

function normalizeStatus(value, fallback) {
  const raw = String(value || "").toLowerCase();
  if (raw === "answered") return "in-progress";
  if (CALL_STATUSES.has(raw)) return raw;
  return fallback;
}

function normalizeDirection(value) {
  const raw = String(value || "inbound").toLowerCase();
  if (raw === "inbound") return "inbound";
  if (raw === "outbound" || raw.startsWith("outbound-")) return raw === "outbound" ? "outbound" : raw;
  return "inbound";
}

export function listStoredCalls(accountSid) {
  return getDb().prepare(`
    SELECT * FROM twilio_calls
    WHERE account_sid = ?
    ORDER BY COALESCE(start_time, date_created) DESC
    LIMIT 200
  `).all(accountSid).map(mapCall);
}

export function getStoredCall(sid) {
  const row = getDb().prepare("SELECT * FROM twilio_calls WHERE sid = ?").get(sid);
  return row ? mapCall(row) : null;
}

export function getStoredCallForAccount(accountSid, sid) {
  const row = getDb().prepare("SELECT * FROM twilio_calls WHERE account_sid = ? AND sid = ?").get(accountSid, sid);
  return row ? mapCall(row) : null;
}

export function upsertCall(input) {
  const now = new Date().toISOString();
  const existing = getDb().prepare("SELECT date_created FROM twilio_calls WHERE sid = ?").get(input.sid);
  getDb().prepare(`
    INSERT INTO twilio_calls (
      sid, account_sid, parent_call_sid, from_number, to_number, phone_number_sid, direction, status,
      start_time, end_time, duration, recording_url, recording_sid, price, local_call_id, media,
      annotation, demo, date_created, date_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET
      status = excluded.status,
      end_time = COALESCE(excluded.end_time, twilio_calls.end_time),
      duration = COALESCE(excluded.duration, twilio_calls.duration),
      recording_url = COALESCE(excluded.recording_url, twilio_calls.recording_url),
      recording_sid = COALESCE(excluded.recording_sid, twilio_calls.recording_sid),
      to_number = excluded.to_number,
      from_number = excluded.from_number,
      phone_number_sid = COALESCE(excluded.phone_number_sid, twilio_calls.phone_number_sid),
      direction = excluded.direction,
      annotation = COALESCE(excluded.annotation, twilio_calls.annotation),
      date_updated = excluded.date_updated
  `).run(
    input.sid,
    input.accountSid,
    input.parentCallSid || null,
    input.from,
    input.to,
    input.phoneNumberSid || null,
    normalizeDirection(input.direction),
    normalizeStatus(input.status, "queued"),
    input.startTime || now,
    input.endTime || null,
    input.duration == null ? null : Number(input.duration),
    input.recordingUrl || null,
    input.recordingSid || null,
    input.price || null,
    input.localCallId || null,
    input.media || null,
    input.annotation || "",
    input.demo === false ? 0 : 1,
    existing?.date_created || input.dateCreated || now,
    now,
  );
  return getStoredCall(input.sid);
}

function browserCallInput(call, { status, durationMs, endedAt } = {}) {
  const accountSid = demoAccountSid();
  const number = primaryNumber(accountSid);
  const seconds = durationMs == null ? null : Math.max(0, Math.round(Number(durationMs) / 1000));
  const twilioStatus = status === "failed" ? "failed" : status === "in-progress" ? "in-progress" : "completed";
  const now = new Date().toISOString();
  return {
    sid: stableSid("CA", `browser:${call.id}`),
    account_sid: accountSid,
    parent_call_sid: null,
    to: number?.phone_number || "client:maison-sol",
    from: "client:browser",
    phone_number_sid: number?.sid || null,
    status: twilioStatus,
    start_time: call.startedAt || now,
    end_time: endedAt || null,
    duration: seconds == null ? null : String(seconds),
    price: null,
    price_unit: "USD",
    direction: "inbound",
    answered_by: null,
    api_version: "2010-04-01",
    forwarded_from: null,
    caller_name: null,
    recording_url: null,
    recording_sid: null,
    demo: true,
    media: "browser-realtime",
    local_call_id: call.id,
    annotation: "Browser client. Audio is OpenAI Realtime in the browser, not a PSTN recording.",
    date_created: call.startedAt || now,
    date_updated: now,
    uri: `/api/twilio/v1/Accounts/${accountSid}/Calls/${stableSid("CA", `browser:${call.id}`)}`,
    subresource_uris: {
      recordings: `/api/twilio/v1/Accounts/${accountSid}/Calls/${stableSid("CA", `browser:${call.id}`)}/Recordings`,
    },
  };
}

export function previewBrowserCall(call) {
  if (!call?.id || call.source === "seed" || call.status !== "active") return null;
  const started = Date.parse(call.startedAt);
  const durationMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
  return browserCallInput(call, { status: "in-progress", durationMs, endedAt: null });
}

export function mirrorBrowserCall(call, { status, durationMs, endedAt } = {}) {
  if (!call?.id || call.source === "seed") return null;
  const preview = browserCallInput(call, { status, durationMs, endedAt });
  return upsertCall({
    sid: preview.sid,
    accountSid: preview.account_sid,
    from: preview.from,
    to: preview.to,
    phoneNumberSid: preview.phone_number_sid,
    direction: preview.direction,
    status: preview.status,
    startTime: preview.start_time,
    endTime: preview.end_time,
    duration: preview.duration == null ? null : Number(preview.duration),
    recordingUrl: null,
    localCallId: preview.local_call_id,
    media: preview.media,
    annotation: preview.annotation,
    demo: true,
  });
}

export function recordingsFor(call) {
  if (!call?.recording_sid && !call?.recording_url) return [];
  return [{
    sid: call.recording_sid || stableSid("RE", call.sid),
    account_sid: call.account_sid,
    call_sid: call.sid,
    status: "absent",
    duration: call.duration,
    media_url: null,
    demo: true,
    note: "Demo stub. No audio file is stored. PSTN recordings need Twilio recording or Media Streams.",
    uri: call.recording_url || `/api/twilio/v1/Accounts/${call.account_sid}/Calls/${call.sid}/Recordings`,
    date_created: call.start_time,
  }];
}

export function listApps(accountSid) {
  return getDb().prepare(`
    SELECT * FROM twilio_apps WHERE account_sid = ? ORDER BY friendly_name
  `).all(accountSid).map(mapApp);
}

export function getApp(accountSid, sid) {
  const row = getDb().prepare("SELECT * FROM twilio_apps WHERE account_sid = ? AND sid = ?").get(accountSid, sid);
  return row ? mapApp(row) : null;
}

export function createDemoApp(accountSid, input) {
  const name = cleanText(input.friendlyName, 64);
  if (!name) throw httpError(400, "Friendly name is required");
  const now = new Date().toISOString();
  const sid = randomSid("AP");
  getDb().prepare(`
    INSERT INTO twilio_apps (
      sid, account_sid, friendly_name, voice_url, voice_method, status_callback,
      status_callback_method, sms_url, sms_method, demo, date_created, date_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'POST', 1, ?, ?)
  `).run(
    sid,
    accountSid,
    name,
    input.voiceUrl == null ? "/twilio/voice" : cleanWebhookUrl(input.voiceUrl),
    method(input.voiceMethod),
    input.statusCallback == null ? "/twilio/status" : cleanWebhookUrl(input.statusCallback),
    method(input.statusCallbackMethod),
    now,
    now,
  );
  return getApp(accountSid, sid);
}

export function updateDemoApp(accountSid, sid, input) {
  const current = getApp(accountSid, sid);
  if (!current) throw httpError(404, "The requested resource was not found");
  const name = Object.prototype.hasOwnProperty.call(input, "friendlyName")
    ? cleanText(input.friendlyName, 64)
    : current.friendly_name;
  if (!name) throw httpError(400, "Friendly name is required");
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE twilio_apps SET
      friendly_name = ?, voice_url = ?, voice_method = ?, status_callback = ?,
      status_callback_method = ?, date_updated = ?
    WHERE sid = ? AND account_sid = ?
  `).run(
    name,
    Object.prototype.hasOwnProperty.call(input, "voiceUrl") ? cleanWebhookUrl(input.voiceUrl) : current.voice_url,
    Object.prototype.hasOwnProperty.call(input, "voiceMethod") ? method(input.voiceMethod) : current.voice_method,
    Object.prototype.hasOwnProperty.call(input, "statusCallback") ? cleanWebhookUrl(input.statusCallback) : current.status_callback,
    Object.prototype.hasOwnProperty.call(input, "statusCallbackMethod") ? method(input.statusCallbackMethod) : current.status_callback_method,
    now,
    sid,
    accountSid,
  );
  return getApp(accountSid, sid);
}

export function listEvents(accountSid) {
  return getDb().prepare(`
    SELECT * FROM twilio_events WHERE account_sid = ? ORDER BY date_created DESC LIMIT 200
  `).all(accountSid).map(mapEvent);
}

export function getEvent(accountSid, sid) {
  const row = getDb().prepare("SELECT * FROM twilio_events WHERE account_sid = ? AND sid = ?").get(accountSid, sid);
  return row ? mapEvent(row) : null;
}

export function recordEvent(input) {
  const sid = input.sid || randomSid("NO");
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO twilio_events (
      sid, account_sid, request_method, request_url, call_sid, request_json, response_status,
      response_body, log_level, message, signature, date_created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sid,
    input.accountSid,
    input.method,
    input.url,
    input.callSid || null,
    JSON.stringify(input.variables || {}),
    input.status,
    input.body || "",
    input.level || "info",
    input.message,
    input.signature || "absent",
    now,
  );
  return getEvent(input.accountSid, sid);
}

function cleanSid(value, prefix) {
  const text = cleanText(value, 40);
  if (!text) return "";
  if (!isSid(text, prefix)) throw httpError(400, `${prefix} SID is not valid`);
  return text;
}

function cleanSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text !== text.trim() || /\s/.test(text) || text.length < 16 || text.length > 128) {
    throw httpError(400, "Secret must be 16 to 128 characters without spaces");
  }
  return text;
}

export function saveCredentials(input) {
  const current = readAccount();
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const savedAccountSid = has("savedAccountSid")
    ? cleanSid(input.savedAccountSid, "AC") || null
    : current.saved_account_sid;
  const apiKeySid = has("apiKeySid")
    ? cleanSid(input.apiKeySid, "SK") || null
    : current.api_key_sid;
  const authToken = has("authToken") && input.authToken
    ? cleanSecret(input.authToken)
    : current.auth_token;
  const apiKeySecret = has("apiKeySecret") && input.apiKeySecret
    ? cleanSecret(input.apiKeySecret)
    : current.api_key_secret;
  getDb().prepare(`
    UPDATE twilio_account SET
      saved_account_sid = ?, auth_token = ?, api_key_sid = ?, api_key_secret = ?, updated_at = ?
    WHERE id = 1
  `).run(savedAccountSid, authToken, apiKeySid, apiKeySecret, new Date().toISOString());
  return readAccount();
}

export function clearCredentials() {
  getDb().prepare(`
    UPDATE twilio_account SET
      saved_account_sid = NULL, auth_token = NULL, api_key_sid = NULL, api_key_secret = NULL, updated_at = ?
    WHERE id = 1
  `).run(new Date().toISOString());
  return readAccount();
}

export function matchesCall(call, { status, from, to, direction } = {}) {
  if (status && call.status !== status) return false;
  if (from && !String(call.from || "").includes(from)) return false;
  if (to && !String(call.to || "").includes(to)) return false;
  if (direction === "inbound" && call.direction !== "inbound") return false;
  if (direction === "outbound" && !String(call.direction || "").startsWith("outbound")) return false;
  if (direction && direction !== "inbound" && direction !== "outbound" && call.direction !== direction) return false;
  return true;
}
