import { publicBase } from "./http.js";

/**
 * Agents brain origin only. Strips trailing slash and known webhook suffixes
 * (/twilio/voice, /twilio/status, /twilio/media), including query/hash.
 * Paste of a full voice webhook still yields the host origin.
 */
export function normalizeAgentsBaseUrl(url) {
  let raw = String(url || "").trim();
  if (!raw) return "";
  const suffixes = ["/twilio/voice", "/twilio/status", "/twilio/media"];
  const stripSuffix = (pathname) => {
    let path = String(pathname || "").replace(/\/+$/, "") || "";
    for (const suffix of suffixes) {
      if (path === suffix || path.endsWith(suffix)) {
        path = path.slice(0, -suffix.length);
        break;
      }
    }
    return path.replace(/\/+$/, "");
  };
  try {
    const parsed = new URL(raw);
    const path = stripSuffix(parsed.pathname);
    return `${parsed.origin}${path}`;
  } catch {
    raw = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
    for (const suffix of suffixes) {
      if (raw.endsWith(suffix)) {
        raw = raw.slice(0, -suffix.length);
        break;
      }
    }
    return raw.replace(/\/+$/, "");
  }
}

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
  const agents = normalizeAgentsBaseUrl(process.env.AGENTS_PUBLIC_URL || "");
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

/** Pull agentId from a Voice URL query string (absolute or path). */
export function parseAgentIdFromVoiceUrl(voiceUrl) {
  const raw = String(voiceUrl || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("/") ? new URL(raw, "http://local.invalid") : new URL(raw);
    return String(url.searchParams.get("agentId") || url.searchParams.get("agent") || "").trim();
  } catch {
    const match = raw.match(/[?&]agentId=([^&]+)/i) || raw.match(/[?&]agent=([^&]+)/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return String(match[1] || "").trim();
    }
  }
}
