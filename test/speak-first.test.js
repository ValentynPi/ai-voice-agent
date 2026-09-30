import assert from "node:assert/strict";
import test from "node:test";
import { canAttemptGreeting, greetingFailureAction, greetingLine } from "../public/js/speak-first.js";

const ready = {
  hasGreeting: true,
  greetingSent: false,
  greetingTries: 0,
  channelOpen: true,
  sessionReady: true,
  answerApplied: true,
  channelState: "open",
};

test("greeting waits until the data channel, session, and SDP answer are all ready", () => {
  assert.equal(canAttemptGreeting({ ...ready, answerApplied: false }), "wait");
  assert.equal(canAttemptGreeting({ ...ready, channelOpen: false }), "wait");
  assert.equal(canAttemptGreeting({ ...ready, sessionReady: false }), "wait");
  assert.equal(canAttemptGreeting({ ...ready, channelState: "connecting" }), "wait");
  assert.equal(canAttemptGreeting(ready), "send");
  assert.equal(canAttemptGreeting({ ...ready, greetingSent: true }), "skip");
  assert.equal(canAttemptGreeting({ ...ready, greetingTries: 3 }), "skip");
  assert.equal(canAttemptGreeting({ ...ready, hasGreeting: false }), "release");
});

test("a greeting that was not heard can be retried a few times", () => {
  const base = { greetingSent: true, greetingHeardAudio: false, greetingTries: 1 };
  assert.equal(greetingFailureAction({ ...base, status: "failed" }), "retry");
  assert.equal(greetingFailureAction({ ...base, status: "cancelled" }), "retry");
  assert.equal(greetingFailureAction({ ...base, status: "error" }), "retry");
  assert.equal(greetingFailureAction({ ...base, status: "completed" }), "retry");
  assert.equal(greetingFailureAction({ ...base, greetingTries: 3, status: "failed" }), "give-up");
  assert.equal(greetingFailureAction({ ...base, greetingHeardAudio: true, status: "failed" }), "ignore");
  assert.equal(greetingFailureAction({ ...base, greetingSent: false, status: "failed" }), "ignore");
});

test("greeting line is the script after the instructions", () => {
  const line = greetingLine("The call just connected.\n\nHello, this is Sol at Maison Sol in Castellón.");
  assert.equal(line, "Hello, this is Sol at Maison Sol in Castellón.");
});
