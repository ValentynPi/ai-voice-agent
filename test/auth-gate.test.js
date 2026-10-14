import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsAuthEnabled,
  isOpenApiPath,
  isPublicPagePath,
  isTelephonyBrainPath,
  isTrustedTelephonyProxy
} from "../src/auth-gate.js";

test("agents auth defaults on for agents service only", () => {
  assert.equal(agentsAuthEnabled("agents"), true);
  assert.equal(agentsAuthEnabled("all"), false);
  assert.equal(agentsAuthEnabled("telephony"), false);
});

test("public and open API paths", () => {
  assert.equal(isPublicPagePath("/signin"), true);
  assert.equal(isPublicPagePath("/agents"), false);
  assert.equal(isOpenApiPath("GET", "/api/health"), true);
  assert.equal(isOpenApiPath("POST", "/api/auth/signin"), true);
  assert.equal(isOpenApiPath("GET", "/api/agents"), true);
  assert.equal(isOpenApiPath("POST", "/api/agents"), false);
  assert.equal(isOpenApiPath("GET", "/api/state"), false);
});

test("telephony brain paths", () => {
  assert.equal(isTelephonyBrainPath("POST", "/api/calls"), true);
  assert.equal(isTelephonyBrainPath("POST", "/api/realtime/token"), true);
  assert.equal(isTelephonyBrainPath("GET", "/api/agents/agt_x"), true);
  assert.equal(isTelephonyBrainPath("POST", "/api/agents"), false);
});

test("trusted telephony proxy when origin omitted", () => {
  const req = { get: () => "" };
  assert.equal(isTrustedTelephonyProxy(req), true);
  const browser = {
    get: (name) => (name === "origin" ? "https://ai-voice-agent-valmax.fly.dev" : ""),
  };
  assert.equal(isTrustedTelephonyProxy(browser), false);
});
