import { createHmac, timingSafeEqual } from "node:crypto";
import { credentialEnvironment } from "./live.js";
import { publicBase } from "./http.js";
import { isSid, randomSid } from "./ids.js";
import { defaultVoiceTarget } from "./service.js";
import { demoAccountSid, getStoredCall, readAccount, recordEvent, upsertCall } from "./store.js";
import { voiceTwiml } from "./twiml.js";

function publicParams(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (/token|secret|authorization|auth/i.test(key)) continue;
    if (Array.isArray(value)) continue;
    out[key] = String(value).slice(0, 500);
  }
  return out;
}

function signatureState(req, params) {
  const header = req.get("x-twilio-signature");
  if (!header) return "absent";
  const env = credentialEnvironment();
  const token = env.live?.authToken || readAccount().auth_token || "";
  if (!token) return "unchecked";
  const url = `${publicBase(req)}${req.originalUrl}`;
  const keys = Object.keys(params).sort();
  let data = url;
  for (const key of keys) data += key + params[key];
  const digest = createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  const left = Buffer.from(digest);
  const right = Buffer.from(String(header));
  if (left.length !== right.length) return "invalid";
  return timingSafeEqual(left, right) ? "valid" : "invalid";
}

function callSidFrom(params) {
  const raw = String(params.CallSid || "").trim();
  if (isSid(raw, "CA")) return raw;
  if (raw) return randomSid("CA");
  return "";
}

function rememberCall(params, { status, endTime }) {
  const sid = callSidFrom(params);
  if (!sid) return "";
  const existing = getStoredCall(sid);
  const accountSid = demoAccountSid();
  const to = String(params.To || "").trim() || existing?.to || defaultVoiceTarget();
  const from = String(params.From || "").trim() || existing?.from || "unknown";
  const duration = params.CallDuration == null || params.CallDuration === "" ? null : Number(params.CallDuration);
  upsertCall({
    sid,
    accountSid,
    from,
    to,
    direction: params.Direction || existing?.direction || "inbound",
    status: status || params.CallStatus || "ringing",
    startTime: params.Timestamp || undefined,
    endTime,
    duration: Number.isFinite(duration) ? duration : null,
    recordingUrl: params.RecordingUrl || null,
    recordingSid: isSid(params.RecordingSid, "RE") ? params.RecordingSid : null,
    media: "twiml",
    annotation: "Captured from the voice webhook on this app.",
    demo: true,
  });
  return sid;
}

function logDelivery(req, { callSid, status, body, message, level, signature }) {
  recordEvent({
    accountSid: demoAccountSid(),
    method: req.method,
    url: req.originalUrl.split("?")[0],
    callSid,
    variables: publicParams(req.body),
    status,
    body,
    level,
    message,
    signature,
  });
}

export function voiceWebhook(req, res) {
  const params = publicParams(req.body);
  const signature = signatureState(req, params);
  const callSid = rememberCall(params, { status: params.CallStatus || "ringing" });
  const xml = voiceTwiml();
  const invalid = signature === "invalid";
  logDelivery(req, {
    callSid,
    status: 200,
    body: xml,
    level: invalid ? "warning" : "info",
    message: invalid ? "Voice webhook answered with TwiML. Signature did not match." : "Voice webhook answered with TwiML",
    signature,
  });
  res.status(200).type("text/xml").send(xml);
}

export function statusWebhook(req, res) {
  const params = publicParams(req.body);
  const signature = signatureState(req, params);
  const terminal = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);
  const status = String(params.CallStatus || "completed").toLowerCase();
  const callSid = rememberCall(params, {
    status,
    endTime: terminal.has(status) ? new Date().toISOString() : null,
  });
  const invalid = signature === "invalid";
  logDelivery(req, {
    callSid,
    status: 204,
    body: "",
    level: invalid ? "warning" : "info",
    message: invalid ? "Status callback stored. Signature did not match." : "Status callback stored",
    signature,
  });
  res.status(204).end();
}
