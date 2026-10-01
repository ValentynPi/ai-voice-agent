import { httpError } from "./http.js";

export function credentialEnvironment() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid && !authToken) return { live: null, warning: "" };
  if (!accountSid || !authToken) {
    return { live: null, warning: "Set both TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to leave Demo mode." };
  }
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    return { live: null, warning: "TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters." };
  }
  return { live: { accountSid, authToken }, warning: "" };
}

function authHeader(creds) {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`;
}

async function request(creds, path, { method = "GET", query, form } = {}) {
  const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers = { Authorization: authHeader(creds), Accept: "application/json" };
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value != null && value !== "") params.set(key, String(value));
    }
    body = params.toString();
  }
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10000) });
  } catch {
    throw httpError(502, "Could not reach the Twilio API");
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload.message === "string" ? payload.message : `Twilio returned ${response.status}`;
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw httpError(status, message);
  }
  return payload || {};
}

export function listIncomingPhoneNumbers(creds, query) {
  return request(creds, "/IncomingPhoneNumbers.json", {
    query: { PageSize: 50, PhoneNumber: query.phoneNumber, FriendlyName: query.friendlyName },
  });
}

export function fetchIncomingPhoneNumber(creds, sid) {
  return request(creds, `/IncomingPhoneNumbers/${sid}.json`);
}

export function createIncomingPhoneNumber(creds, form) {
  return request(creds, "/IncomingPhoneNumbers.json", { method: "POST", form });
}

export function updateIncomingPhoneNumber(creds, sid, form) {
  return request(creds, `/IncomingPhoneNumbers/${sid}.json`, { method: "POST", form });
}

export function listAvailableNumbers(creds, country, query) {
  return request(creds, `/AvailablePhoneNumbers/${country}/Local.json`, {
    query: {
      PageSize: 20,
      VoiceEnabled: "true",
      SmsEnabled: query.sms ? "true" : "",
      Contains: query.contains,
    },
  });
}

export function listCalls(creds, query) {
  return request(creds, "/Calls.json", {
    query: { PageSize: 50, Status: query.status, From: query.from, To: query.to },
  });
}

export function fetchCall(creds, sid) {
  return request(creds, `/Calls/${sid}.json`);
}

export function listCallRecordings(creds, sid) {
  return request(creds, `/Calls/${sid}/Recordings.json`, { query: { PageSize: 20 } });
}

export function listApplications(creds) {
  return request(creds, "/Applications.json", { query: { PageSize: 50 } });
}

export function fetchApplication(creds, sid) {
  return request(creds, `/Applications/${sid}.json`);
}

export function createApplication(creds, form) {
  return request(creds, "/Applications.json", { method: "POST", form });
}

export function updateApplication(creds, sid, form) {
  return request(creds, `/Applications/${sid}.json`, { method: "POST", form });
}
