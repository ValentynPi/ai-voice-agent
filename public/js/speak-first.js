export const MAX_GREETING_TRIES = 3;

const RETRY_STATUS = new Set(["failed", "cancelled", "incomplete", "error", "completed"]);

export function canAttemptGreeting(state) {
  if (!state?.hasGreeting) return "release";
  if (state.greetingSent) return "skip";
  const tries = state.greetingTries || 0;
  const maxTries = state.maxTries ?? MAX_GREETING_TRIES;
  if (tries >= maxTries) return "skip";
  if (!state.channelOpen || !state.sessionReady || !state.answerApplied) return "wait";
  if (state.channelState !== "open") return "wait";
  return "send";
}

export function greetingFailureAction(state) {
  if (!state?.greetingSent || state.greetingHeardAudio) return "ignore";
  if (!RETRY_STATUS.has(state.status)) return "ignore";
  const tries = state.greetingTries || 0;
  const maxTries = state.maxTries ?? MAX_GREETING_TRIES;
  if (tries >= maxTries) return "give-up";
  return "retry";
}

export function greetingLine(instructions) {
  const text = String(instructions || "").trim();
  if (!text) return "";
  const parts = text.split(/\n\n/);
  return (parts[parts.length - 1] || "").trim();
}
