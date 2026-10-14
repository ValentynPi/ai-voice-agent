/**
 * Agents console auth gate: signed-in session required for product UI/APIs.
 * Public: health, auth endpoints, Twilio webhooks, static assets, and
 * telephony brain-proxy paths (server-side, no browser session).
 */
import { telephonySharedSecret } from "./twilio/public-list.js";

export function isSignedIn(req) {
  return Boolean(req?.account?.id) && !req.account.isDemo;
}

function pathOf(req) {
  return String(req.path || req.url || "").split("?")[0];
}

/** HTML / static paths that stay reachable without a session. */
export function isPublicPagePath(pathname) {
  const p = String(pathname || "");
  if (p === "/signin" || p === "/signup") return true;
  if (p.startsWith("/css/") || p.startsWith("/js/")) return true;
  if (p === "/favicon.ico" || p.startsWith("/favicon")) return true;
  return false;
}

/** API routes that stay open without a signed-in session. */
export function isOpenApiPath(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  const p = String(pathname || "");
  if (p === "/api/health") return true;
  if (p.startsWith("/api/auth/")) return true;
  // Telephony Overview CORS: list agents (read-only).
  if (m === "GET" && p === "/api/agents") return true;
  return false;
}

/**
 * Paths the telephony host proxies for the in-console dialer.
 * Allowed without session when the request is not a browser Origin on Agents,
 * or when a shared telephony secret is presented.
 */
export function isTelephonyBrainPath(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  const p = String(pathname || "");
  if (m === "POST" && p === "/api/calls") return true;
  if (m === "POST" && /^\/api\/calls\/[^/]+\/(heartbeat|end)$/.test(p)) return true;
  if (m === "POST" && /^\/api\/realtime\/(token|utterance|tool)$/.test(p)) return true;
  if (m === "POST" && p === "/api/chat") return true;
  if (m === "GET" && p === "/api/tools") return true;
  if (m === "GET" && /^\/api\/agents\/[^/]+$/.test(p)) return true;
  return false;
}

function hasTrustedTelephonySecret(req) {
  const expected = telephonySharedSecret();
  if (!expected) return false;
  const header = String(req.get("x-telephony-secret") || "").trim();
  const auth = String(req.get("authorization") || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return header === expected || bearer === expected;
}

/** True when this looks like the telephony server proxy (not the Agents browser). */
export function isTrustedTelephonyProxy(req) {
  if (hasTrustedTelephonySecret(req)) return true;
  const origin = String(req.get("origin") || "").trim();
  // Browser calls always send Origin on cross-site and usually on same-site fetch.
  // Node fetch from telephony proxy typically omits Origin.
  if (!origin) return true;
  const telephony = String(process.env.TELEPHONY_PUBLIC_URL || "").replace(/\/$/, "");
  if (telephony && origin.replace(/\/$/, "") === telephony) return true;
  return false;
}

export function agentsAuthEnabled(service = process.env.SERVICE) {
  const mode = String(service || "all").trim().toLowerCase();
  if (process.env.AGENTS_REQUIRE_AUTH === "0") return false;
  if (process.env.AGENTS_REQUIRE_AUTH === "1") return true;
  return mode === "agents";
}

export function createAgentsAuthGate({ enabled } = {}) {
  const on = enabled == null ? agentsAuthEnabled() : Boolean(enabled);

  return function agentsAuthGate(req, res, next) {
    if (!on) return next();
    if (isSignedIn(req)) return next();

    const pathname = pathOf(req);
    const method = req.method || "GET";

    // Twilio webhooks (mounted under /twilio) — never block.
    if (pathname.startsWith("/twilio")) return next();
    if (isPublicPagePath(pathname)) return next();

    if (pathname.startsWith("/api/")) {
      if (isOpenApiPath(method, pathname)) return next();
      if (isTelephonyBrainPath(method, pathname) && isTrustedTelephonyProxy(req)) return next();
      return res.status(401).json({ error: "Sign in required", signin: "/signin" });
    }

    // Product HTML pages
    if (method === "GET" || method === "HEAD") {
      const nextUrl = req.originalUrl || "/agents";
      return res.redirect(302, `/signin?next=${encodeURIComponent(nextUrl)}`);
    }

    return res.status(401).json({ error: "Sign in required", signin: "/signin" });
  };
}

/** Reject cross-site mutating requests that carry a session cookie (CSRF belt). */
export function createSameOriginGuard({ enabled } = {}) {
  const on = enabled == null ? agentsAuthEnabled() : Boolean(enabled);
  return function sameOriginGuard(req, res, next) {
    if (!on) return next();
    if (!isSignedIn(req)) return next();
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const origin = String(req.get("origin") || "").trim();
    if (!origin) return next();
    const publicUrl = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
    const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
    const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    const expected = publicUrl || (host ? `${proto}://${host}` : "");
    if (expected && origin.replace(/\/$/, "") === expected.replace(/\/$/, "")) return next();
    return res.status(403).json({ error: "Cross-origin request blocked" });
  };
}
