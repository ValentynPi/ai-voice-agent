/**
 * Plain-language reasons the live voice could not start. The old hint always
 * said "voice Chloe is unavailable … Open Sign in" whenever the token call
 * returned 401 — but OpenAI rejecting the server key also surfaced as 401.
 */
export function tokenFailure(status, body = {}) {
  const code = String(body?.code || "");
  const detail = String(body?.error || "").trim();
  if (status === 401 && (body?.signin || /sign in required/i.test(detail))) {
    return { kind: "signin", message: "Your sign-in has expired. Sign in again, then press Start call." };
  }
  if (code === "openai_quota") {
    return { kind: "openai", message: "The OpenAI account behind this desk is out of credits. Add credits in OpenAI billing, then try again." };
  }
  if (code === "openai_key_invalid" || code === "openai_key_missing") {
    return { kind: "openai", message: "The server's OpenAI API key is missing or was revoked. A new key has to be set on the server." };
  }
  if (code === "openai_busy") {
    return { kind: "openai", message: "OpenAI is rate-limiting this desk right now. Wait a moment and try again." };
  }
  if (status === 404 || status === 409) {
    return { kind: "call", message: "This call ended before the voice connected. Press Start call again." };
  }
  return { kind: "server", message: `The voice service could not start (${detail || `HTTP ${status}`}). Try again in a moment.` };
}

export function voiceUnavailableHint(reason, agentLabel = "The agent") {
  const why = String(reason || "The voice connection failed.").trim();
  return `Live voice is off: ${why} ${agentLabel} will not use a browser voice. You can still type and read the reply.`;
}

/**
 * The token can mint (200) while the account is already out of credits: the
 * failure then arrives later, as the WebRTC SDP answer (HTTP 429), an `error`
 * event, or a response.done with status "failed" and
 * status_details.error.code "insufficient_quota". Those used to show a plain
 * "Voice unavailable". Returns a tokenFailure-style object or null.
 */
export function realtimeAccountFailure(source, status = 0) {
  let text = "";
  try {
    text = typeof source === "string" ? source : JSON.stringify(source ?? "");
  } catch {
    text = String(source || "");
  }
  if (/insufficient_quota|credit_balance|out of credits|exceeded your current quota|billing/i.test(text)) {
    return tokenFailure(503, { code: "openai_quota" });
  }
  if (status === 401 || /invalid_api_key|token_invalidated|Incorrect API key/i.test(text)) {
    return tokenFailure(503, { code: "openai_key_invalid" });
  }
  if (status === 429 || /rate_limit_exceeded/i.test(text)) {
    return tokenFailure(503, { code: "openai_busy" });
  }
  return null;
}

/** Failure details carried by a Realtime server event, if any. */
export function realtimeEventFailure(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "error") return realtimeAccountFailure(event.error || event);
  if (event.type === "response.done" && event.response?.status === "failed") {
    return realtimeAccountFailure(event.response?.status_details || event.response);
  }
  return null;
}
