/**
 * When SERVICE=telephony, forward browser-call brain APIs to AGENTS_PUBLIC_URL
 * so the interactive dialer can stay same-origin on the telephony console.
 */
import { normalizeAgentsBaseUrl } from "./public-url.js";

const PROXY_POST = new Set([
  "/api/calls",
  "/api/chat",
  "/api/realtime/token",
  "/api/realtime/utterance",
  "/api/realtime/tool",
]);

function isProxyPath(method, path) {
  const p = String(path || "");
  const m = String(method || "").toUpperCase();
  if (m === "POST" && PROXY_POST.has(p)) return true;
  if (m === "POST" && /^\/api\/calls\/[^/]+\/(heartbeat|end)$/.test(p)) return true;
  if (m === "GET" && p === "/api/tools") return true;
  if (m === "GET" && /^\/api\/agents\/[^/]+$/.test(p)) return true;
  return false;
}

function allowedBrainBase(agentsPublicUrl, requested) {
  const env = normalizeAgentsBaseUrl(agentsPublicUrl || "");
  const want = normalizeAgentsBaseUrl(requested || "");
  if (!env) return want || "";
  if (!want || want === env) return env;
  // Prevent SSRF: only the configured Agents brain may be used.
  return "";
}

export function createBrainProxy({ service, agentsPublicUrl }) {
  const configured = normalizeAgentsBaseUrl(agentsPublicUrl || "");
  if (String(service || "").toLowerCase() !== "telephony" || !configured) {
    return (_req, _res, next) => next();
  }

  return async function brainProxy(req, res, next) {
    if (!isProxyPath(req.method, req.path)) return next();

    const requested = String(req.get("x-agents-base") || req.query?.agents_base || "").trim();
    const brain = allowedBrainBase(configured, requested);
    if (!brain) {
      return res.status(400).json({
        error: "Agents brain URL is not allowed. Use the configured Agents host.",
      });
    }

    // Drop agents_base from query when forwarding (keep other query as-is).
    let forwardUrl = `${brain}${req.path}`;
    if (req.method === "GET" && req.url.includes("?")) {
      const params = new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1));
      params.delete("agents_base");
      const qs = params.toString();
      if (qs) forwardUrl += `?${qs}`;
    }

    const headers = { Accept: "application/json" };
    if (req.accountId) headers["X-Tenant-Id"] = String(req.accountId);
    const init = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(60000),
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body || {});
    }

    try {
      const upstream = await fetch(forwardUrl, init);
      const text = await upstream.text();
      const ct = upstream.headers.get("content-type") || "application/json; charset=utf-8";
      res.status(upstream.status);
      res.setHeader("Content-Type", ct);
      res.send(text);
    } catch (error) {
      const err = new Error(error?.message || "Could not reach Agents brain");
      err.status = 502;
      err.expose = true;
      next(err);
    }
  };
}
