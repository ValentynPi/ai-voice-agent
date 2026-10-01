import { publicBase } from "./http.js";

/** Absolute public origin for this process (no trailing slash). */
export function resolvePublicUrl(req) {
  const fromEnv = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const fly = String(process.env.FLY_APP_NAME || "").trim();
  if (fly) return `https://${fly}.fly.dev`;
  if (req) return publicBase(req);
  return "";
}

/** Agents brain origin. Prefer AGENTS_PUBLIC_URL; on agents hosts fall back to this app. */
export function resolveAgentsPublicUrl(req) {
  const agents = String(process.env.AGENTS_PUBLIC_URL || "").replace(/\/$/, "");
  if (agents) return agents;
  const service = String(process.env.SERVICE || "all").trim().toLowerCase();
  if (service === "telephony") return "";
  return resolvePublicUrl(req);
}

export function httpToWs(url) {
  const raw = String(url || "");
  if (raw.startsWith("https://")) return `wss://${raw.slice("https://".length)}`;
  if (raw.startsWith("http://")) return `ws://${raw.slice("http://".length)}`;
  if (raw.startsWith("wss://") || raw.startsWith("ws://")) return raw;
  return raw;
}
