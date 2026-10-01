import { accountView, assignAgentToNumber, listPhoneNumbers, parseAgentIdFromVoiceUrl } from "./service.js";
import { isSid } from "./ids.js";
import { httpError } from "./http.js";

/** Optional shared secret so Agents can pull the telephony number list. */
export function telephonySharedSecret() {
  return String(process.env.TELEPHONY_SHARED_SECRET || "").trim();
}

export function assertTelephonySecret(req) {
  const expected = telephonySharedSecret();
  if (!expected) return; // Demo/public list when unset.
  const header = String(req.get("x-telephony-secret") || "").trim();
  const auth = String(req.get("authorization") || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (header === expected || bearer === expected) return;
  const error = new Error("Unauthorized");
  error.status = 401;
  error.expose = true;
  throw error;
}

function sanitizeNumber(row) {
  const voiceUrl = row.voice_url || "";
  return {
    sid: row.sid,
    phone_number: row.phone_number,
    friendly_name: row.friendly_name,
    status: row.status || "in-use",
    demo: Boolean(row.demo),
    origin: row.origin || (row.demo ? "demo" : "twilio"),
    voice_url: voiceUrl,
    voice_method: row.voice_method || "POST",
    status_callback: row.status_callback || "",
    agent_id: row.agent_id || parseAgentIdFromVoiceUrl(voiceUrl) || null,
    capabilities: row.capabilities || { voice: true, sms: false, mms: false },
    date_created: row.date_created || null,
    date_updated: row.date_updated || null,
  };
}

/** Assign (or clear) an agent on a number; updates Voice URL via Agents brain. */
export async function assignPublicNumber(req, { sid, agentId } = {}) {
  const numberSid = String(sid || "").trim();
  if (!isSid(numberSid, "PN")) throw httpError(400, "sid must be a phone number SID (PN…)");
  const account = accountView(req);
  const updated = await assignAgentToNumber(account.account_sid, numberSid, agentId, req);
  return {
    ok: true,
    number: sanitizeNumber(updated),
    agents_public_url: account.agents_public_url || null,
  };
}

/** Sanitized IncomingPhoneNumbers for cross-host Agents UI. */
export async function publicPhoneNumbersPayload(req = null) {
  const account = accountView(req);
  const listed = await listPhoneNumbers(account.account_sid, {});
  const numbers = (listed.incoming_phone_numbers || []).map(sanitizeNumber);
  const telephonyUrl = String(process.env.TELEPHONY_PUBLIC_URL || "").replace(/\/$/, "");
  const agentsUrl = String(process.env.AGENTS_PUBLIC_URL || "").replace(/\/$/, "");
  return {
    ok: true,
    source: "telephony",
    mode: account.mode,
    demo: account.demo,
    account_sid: account.account_sid,
    friendly_name: account.friendly_name,
    telephony_public_url: telephonyUrl || null,
    agents_public_url: agentsUrl || account.agents_public_url || null,
    console_path: "/phone-numbers",
    incoming_phone_numbers: numbers,
  };
}
