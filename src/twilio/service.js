import { listActivePublicCalls } from "../store.js";
import { httpError, page, publicBase } from "./http.js";
import { isSid } from "./ids.js";
import {
  createApplication,
  createIncomingPhoneNumber,
  credentialEnvironment,
  fetchApplication,
  fetchCall,
  fetchIncomingPhoneNumber,
  listApplications,
  listAvailableNumbers,
  listCallRecordings,
  listCalls as listLiveCalls,
  listIncomingPhoneNumbers,
  updateApplication,
  updateIncomingPhoneNumber,
} from "./live.js";
import {
  clearCredentials,
  createDemoApp,
  createDemoNumber,
  demoAccountSid,
  getApp,
  getEvent,
  getNumber,
  getStoredCall,
  listApps,
  listAvailable,
  listEvents,
  listNumbers,
  listStoredCalls,
  matchesCall,
  previewBrowserCall,
  primaryNumber,
  readAccount,
  recordingsFor,
  saveCredentials,
  updateDemoApp,
  updateDemoNumber,
} from "./store.js";

function envApiKey() {
  const sid = String(process.env.TWILIO_API_KEY || "").trim();
  const secret = String(process.env.TWILIO_API_KEY_SECRET || "").trim();
  return {
    sid: /^SK[0-9a-fA-F]{32}$/.test(sid) ? sid : "",
    secretSet: Boolean(secret),
  };
}

export function accountView(req) {
  const stored = readAccount();
  const env = credentialEnvironment();
  const live = env.live;
  const apiKey = envApiKey();
  const base = req ? publicBase(req) : "";
  const accountSid = live?.accountSid || stored.account_sid;
  return {
    mode: live ? "connected" : "demo",
    demo: !live,
    account_sid: accountSid,
    friendly_name: stored.friendly_name || "Maison Sol",
    status: "active",
    type: live ? "Full" : "Demo",
    auth_token_set: Boolean(live || stored.auth_token),
    auth_token_source: live ? "environment" : stored.auth_token ? "stored" : "none",
    saved_account_sid: stored.saved_account_sid || null,
    api_key_sid: (live && apiKey.sid) || stored.api_key_sid || null,
    api_key_secret_set: Boolean((live && apiKey.secretSet) || stored.api_key_secret),
    environment_warning: env.warning,
    voice_webhook_url: base ? `${base}/twilio/voice` : "/twilio/voice",
    status_callback_url: base ? `${base}/twilio/status` : "/twilio/status",
    voice_method: "POST",
    status_callback_method: "POST",
    date_created: stored.date_created,
    date_updated: stored.updated_at,
    uri: `/api/twilio/v1/Accounts/${accountSid}`,
  };
}

export function updateCredentials(input) {
  saveCredentials(input);
  return null;
}

export function removeCredentials() {
  clearCredentials();
}

function resolve(sid) {
  if (!isSid(sid, "AC")) throw httpError(404, "The requested resource was not found");
  const env = credentialEnvironment();
  const demoSid = demoAccountSid();
  if (env.live && sid === env.live.accountSid) {
    return { mode: "connected", accountSid: sid, demoSid, live: env.live };
  }
  if (sid === demoSid) {
    if (env.live) {
      throw httpError(404, "That account SID is the local demo. This server is connected with TWILIO_ACCOUNT_SID.");
    }
    return { mode: "demo", accountSid: sid, demoSid, live: null };
  }
  throw httpError(404, "The requested resource was not found");
}

function uriFor(accountSid, path) {
  return `/api/twilio/v1/Accounts/${accountSid}${path}`;
}

function take(items, pageSize) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
  return items.slice(0, size);
}

function mapLiveNumber(row, accountSid) {
  const caps = row.capabilities || {};
  return {
    sid: row.sid,
    account_sid: row.account_sid || accountSid,
    friendly_name: row.friendly_name || row.phone_number,
    phone_number: row.phone_number,
    voice_url: row.voice_url || "",
    voice_method: row.voice_method || "POST",
    voice_fallback_url: row.voice_fallback_url || null,
    voice_fallback_method: row.voice_fallback_method || "POST",
    status_callback: row.status_callback || "",
    status_callback_method: row.status_callback_method || "POST",
    sms_url: row.sms_url || null,
    sms_method: row.sms_method || "POST",
    capabilities: {
      voice: Boolean(caps.voice),
      sms: Boolean(caps.sms ?? caps.SMS),
      mms: Boolean(caps.mms ?? caps.MMS),
    },
    status: row.status || "in-use",
    api_version: row.api_version || "2010-04-01",
    beta: Boolean(row.beta),
    origin: "twilio",
    demo: false,
    date_created: row.date_created,
    date_updated: row.date_updated,
    uri: uriFor(accountSid, `/IncomingPhoneNumbers/${row.sid}`),
  };
}

function mapLiveCall(row, accountSid) {
  return {
    sid: row.sid,
    account_sid: row.account_sid || accountSid,
    parent_call_sid: row.parent_call_sid || null,
    to: row.to,
    from: row.from,
    phone_number_sid: row.phone_number_sid || null,
    status: row.status,
    start_time: row.start_time || row.date_created || null,
    end_time: row.end_time || null,
    duration: row.duration == null || row.duration === "" ? null : String(row.duration),
    price: row.price || null,
    price_unit: row.price_unit || null,
    direction: row.direction,
    answered_by: row.answered_by || null,
    api_version: row.api_version || "2010-04-01",
    forwarded_from: row.forwarded_from || null,
    caller_name: row.caller_name || null,
    recording_url: null,
    recording_sid: null,
    demo: false,
    media: "twilio",
    local_call_id: null,
    annotation: "",
    date_created: row.date_created,
    date_updated: row.date_updated,
    uri: uriFor(accountSid, `/Calls/${row.sid}`),
    subresource_uris: {
      recordings: uriFor(accountSid, `/Calls/${row.sid}/Recordings`),
    },
  };
}

function mapLiveApp(row, accountSid) {
  return {
    sid: row.sid,
    account_sid: row.account_sid || accountSid,
    friendly_name: row.friendly_name,
    voice_url: row.voice_url || "",
    voice_method: row.voice_method || "POST",
    voice_fallback_url: row.voice_fallback_url || null,
    voice_fallback_method: row.voice_fallback_method || "POST",
    status_callback: row.status_callback || "",
    status_callback_method: row.status_callback_method || "POST",
    sms_url: row.sms_url || null,
    sms_method: row.sms_method || "POST",
    api_version: row.api_version || "2010-04-01",
    demo: false,
    date_created: row.date_created,
    date_updated: row.date_updated,
    uri: uriFor(accountSid, `/Applications/${row.sid}`),
  };
}

function mapAvailable(row) {
  const caps = row.capabilities || {};
  return {
    phone_number: row.phone_number,
    friendly_name: row.friendly_name || row.phone_number,
    locality: row.locality || "",
    region: row.region || "",
    postal_code: row.postal_code || null,
    iso_country: row.iso_country || "",
    address_requirements: row.address_requirements || "none",
    beta: Boolean(row.beta),
    capabilities: {
      voice: Boolean(caps.voice ?? caps.Voice),
      SMS: Boolean(caps.SMS ?? caps.sms),
      MMS: Boolean(caps.MMS ?? caps.mms),
    },
    demo: false,
  };
}

function dedupeCalls(calls) {
  const map = new Map();
  for (const call of calls) {
    if (call?.sid) map.set(call.sid, call);
  }
  return [...map.values()].sort((a, b) => {
    const left = Date.parse(a.start_time || a.date_created || "") || 0;
    const right = Date.parse(b.start_time || b.date_created || "") || 0;
    return right - left;
  });
}

function localSupplement() {
  const active = listActivePublicCalls()
    .map((call) => previewBrowserCall(call))
    .filter(Boolean);
  const activeSids = new Set(active.map((call) => call.sid));
  const stored = listStoredCalls(demoAccountSid()).filter((call) => !activeSids.has(call.sid));
  return [...stored, ...active];
}

export async function listPhoneNumbers(accountSid, query) {
  const ctx = resolve(accountSid);
  const path = uriFor(accountSid, "/IncomingPhoneNumbers");
  if (ctx.mode === "connected") {
    const data = await listIncomingPhoneNumbers(ctx.live, query);
    const items = (data.incoming_phone_numbers || []).map((row) => mapLiveNumber(row, accountSid));
    return {
      ...page("incoming_phone_numbers", items, path),
      page: data.page ?? 0,
      page_size: data.page_size ?? items.length,
      next_page_uri: data.next_page_uri || null,
      previous_page_uri: data.previous_page_uri || null,
    };
  }
  return page("incoming_phone_numbers", take(listNumbers(accountSid, query), query.pageSize), path);
}

export async function getPhoneNumber(accountSid, numberSid) {
  const ctx = resolve(accountSid);
  if (!isSid(numberSid, "PN")) throw httpError(404, "The requested resource was not found");
  if (ctx.mode === "connected") {
    const row = await fetchIncomingPhoneNumber(ctx.live, numberSid);
    if (!row?.sid) throw httpError(404, "The requested resource was not found");
    return mapLiveNumber(row, accountSid);
  }
  const number = getNumber(accountSid, numberSid);
  if (!number) throw httpError(404, "The requested resource was not found");
  return number;
}

export async function buyPhoneNumber(accountSid, input) {
  const ctx = resolve(accountSid);
  if (ctx.mode === "connected") {
    if (input.confirmPurchase !== true) {
      throw httpError(400, "Set confirm_purchase to true to buy this number on the connected Twilio account. It can cost money.");
    }
    const created = await createIncomingPhoneNumber(ctx.live, {
      PhoneNumber: input.phoneNumber,
      FriendlyName: input.friendlyName || "",
      VoiceUrl: input.voiceUrl || "",
      VoiceMethod: input.voiceMethod || "POST",
      StatusCallback: input.statusCallback || "",
      StatusCallbackMethod: input.statusCallbackMethod || "POST",
    });
    return mapLiveNumber(created, accountSid);
  }
  return createDemoNumber({
    accountSid,
    phoneNumber: input.phoneNumber,
    friendlyName: input.friendlyName,
    voiceUrl: input.voiceUrl,
    statusCallback: input.statusCallback,
  });
}

export async function changePhoneNumber(accountSid, numberSid, input) {
  const ctx = resolve(accountSid);
  if (ctx.mode === "connected") {
    if (!isSid(numberSid, "PN")) throw httpError(404, "The requested resource was not found");
    const updated = await updateIncomingPhoneNumber(ctx.live, numberSid, {
      FriendlyName: input.friendlyName || "",
      VoiceUrl: input.voiceUrl || "",
      VoiceMethod: input.voiceMethod || "POST",
      StatusCallback: input.statusCallback || "",
      StatusCallbackMethod: input.statusCallbackMethod || "POST",
    });
    return mapLiveNumber(updated, accountSid);
  }
  return updateDemoNumber(accountSid, numberSid, input);
}

export async function searchNumbers(accountSid, country, query) {
  const ctx = resolve(accountSid);
  const iso = String(country || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) throw httpError(400, "Country must be a two-letter code");
  const path = uriFor(accountSid, `/AvailablePhoneNumbers/${iso}/Local`);
  if (ctx.mode === "connected") {
    const data = await listAvailableNumbers(ctx.live, iso, query);
    const items = (data.available_phone_numbers || []).map(mapAvailable);
    return page("available_phone_numbers", items, data.uri || path, { message: "" });
  }
  const result = listAvailable({ country: iso, contains: query.contains, sms: query.sms });
  return page("available_phone_numbers", result.numbers, path, { message: result.message });
}

export async function listCallResources(accountSid, query) {
  const ctx = resolve(accountSid);
  const path = uriFor(accountSid, "/Calls");
  const local = localSupplement().filter((call) => {
    if (ctx.mode === "demo") return call.account_sid === ctx.demoSid;
    return call.media === "browser-realtime" || call.from === "client:browser";
  });
  let remote = [];
  let nextPage = null;
  if (ctx.mode === "connected") {
    const data = await listLiveCalls(ctx.live, query);
    remote = (data.calls || []).map((row) => mapLiveCall(row, accountSid));
    nextPage = data.next_page_uri || null;
  }
  const items = take(
    dedupeCalls([...local, ...remote]).filter((call) => matchesCall(call, query)),
    query.pageSize,
  );
  return { ...page("calls", items, path), next_page_uri: nextPage };
}

export async function getCallResource(accountSid, callSid) {
  const ctx = resolve(accountSid);
  if (!isSid(callSid, "CA")) throw httpError(404, "The requested resource was not found");
  if (ctx.mode === "connected") {
    try {
      const row = await fetchCall(ctx.live, callSid);
      if (row?.sid) return mapLiveCall(row, accountSid);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const local = getStoredCall(callSid);
  if (!local) throw httpError(404, "The requested resource was not found");
  if (ctx.mode === "demo" && local.account_sid !== accountSid) {
    throw httpError(404, "The requested resource was not found");
  }
  return local;
}

export async function listRecordingResources(accountSid, callSid) {
  const call = await getCallResource(accountSid, callSid);
  const path = uriFor(accountSid, `/Calls/${callSid}/Recordings`);
  if (!call.demo && call.media === "twilio") {
    const ctx = resolve(accountSid);
    const data = await listCallRecordings(ctx.live, callSid);
    const items = (data.recordings || []).map((row) => ({
      sid: row.sid,
      account_sid: row.account_sid || accountSid,
      call_sid: row.call_sid || callSid,
      status: row.status,
      duration: row.duration == null ? null : String(row.duration),
      media_url: row.media_url || null,
      demo: false,
      uri: row.uri || `${path}/${row.sid}`,
      date_created: row.date_created,
    }));
    return page("recordings", items, path);
  }
  return page("recordings", recordingsFor(call), path);
}

export async function listAppResources(accountSid) {
  const ctx = resolve(accountSid);
  const path = uriFor(accountSid, "/Applications");
  if (ctx.mode === "connected") {
    const data = await listApplications(ctx.live);
    const items = (data.applications || []).map((row) => mapLiveApp(row, accountSid));
    return page("applications", items, path);
  }
  return page("applications", listApps(accountSid), path);
}

export async function getAppResource(accountSid, appSid) {
  const ctx = resolve(accountSid);
  if (!isSid(appSid, "AP")) throw httpError(404, "The requested resource was not found");
  if (ctx.mode === "connected") {
    const row = await fetchApplication(ctx.live, appSid);
    if (!row?.sid) throw httpError(404, "The requested resource was not found");
    return mapLiveApp(row, accountSid);
  }
  const app = getApp(accountSid, appSid);
  if (!app) throw httpError(404, "The requested resource was not found");
  return app;
}

function appForm(input) {
  return {
    FriendlyName: input.friendlyName || "",
    VoiceUrl: input.voiceUrl || "",
    VoiceMethod: input.voiceMethod || "POST",
    StatusCallback: input.statusCallback || "",
    StatusCallbackMethod: input.statusCallbackMethod || "POST",
  };
}

export async function createAppResource(accountSid, input) {
  const ctx = resolve(accountSid);
  if (ctx.mode === "connected") {
    const created = await createApplication(ctx.live, appForm(input));
    return mapLiveApp(created, accountSid);
  }
  return createDemoApp(accountSid, input);
}

export async function changeAppResource(accountSid, appSid, input) {
  const ctx = resolve(accountSid);
  if (ctx.mode === "connected") {
    if (!isSid(appSid, "AP")) throw httpError(404, "The requested resource was not found");
    const updated = await updateApplication(ctx.live, appSid, appForm(input));
    return mapLiveApp(updated, accountSid);
  }
  return updateDemoApp(accountSid, appSid, input);
}

export function listEventResources(accountSid) {
  const ctx = resolve(accountSid);
  const sid = ctx.mode === "connected" ? ctx.demoSid : accountSid;
  const items = listEvents(sid).map((event) => ({ ...event, account_sid: accountSid }));
  return page("events", items, uriFor(accountSid, "/Monitor/Events"));
}

export function getEventResource(accountSid, eventSid) {
  resolve(accountSid);
  if (!isSid(eventSid, "NO")) throw httpError(404, "The requested resource was not found");
  const event = getEvent(demoAccountSid(), eventSid);
  if (!event) throw httpError(404, "The requested resource was not found");
  return { ...event, account_sid: accountSid };
}

export function defaultVoiceTarget() {
  const number = primaryNumber(demoAccountSid());
  return number?.phone_number || "client:maison-sol";
}
