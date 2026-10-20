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
