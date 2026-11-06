import test from "node:test";
import assert from "node:assert/strict";
import {
  canApplyRemoteAnswer,
  connectFailure,
  realtimeAccountFailure,
  voiceUnavailableHint,
} from "../public/js/voice-failure.js";

test("canApplyRemoteAnswer rejects a closed or stale peer connection", () => {
  assert.equal(canApplyRemoteAnswer({ signalingState: "have-local-offer" }, 3, 3), true);
  assert.equal(canApplyRemoteAnswer({ signalingState: "stable" }, 1, 1), true);
  assert.equal(canApplyRemoteAnswer({ signalingState: "closed" }, 3, 3), false, "closed PC must not get setRemoteDescription");
  assert.equal(canApplyRemoteAnswer({ signalingState: "have-local-offer" }, 2, 3), false, "stale generation");
  assert.equal(canApplyRemoteAnswer(null, 1, 1), false);
  assert.equal(canApplyRemoteAnswer({ get signalingState() { throw new Error("gone"); } }, 1, 1), false);
});

test("connectFailure maps WebRTC closed-state to a clear cancel hint, not the raw InvalidStateError", () => {
  const raw = new Error("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.");
  raw.name = "InvalidStateError";
  const mapped = connectFailure(raw, "Weather");
  assert.equal(mapped.kind, "cancelled");
  assert.match(mapped.message, /closed before it finished|cancelled before it finished|Press Start call/i);
  assert.doesNotMatch(mapped.message, /setRemoteDescription|signalingState/);

  const cancelled = new Error("Voice connection was cancelled before it finished.");
  cancelled.kind = "cancelled";
  assert.equal(connectFailure(cancelled).kind, "cancelled");
});

test("connectFailure keeps out-of-credits and mic hints", () => {
  const credits = realtimeAccountFailure('{"error":{"code":"insufficient_quota"}}', 429);
  const err = new Error(credits.message);
  err.kind = credits.kind;
  const mapped = connectFailure(err, "Weather");
  assert.equal(mapped.kind, "openai");
  assert.match(mapped.message, /out of credits/);
  assert.match(mapped.message, /Live voice is off/);

  const mic = new Error("Permission denied");
  mic.name = "NotAllowedError";
  assert.match(connectFailure(mic).message, /Microphone blocked/);
});

test("voiceUnavailableHint still prefixes unknown reasons (regression)", () => {
  assert.match(voiceUnavailableHint("boom", "Weather"), /Live voice is off: boom/);
});
