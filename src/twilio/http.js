const SECRET_KEYS = new Set([
  "auth_token",
  "authToken",
  "api_key_secret",
  "apiKeySecret",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SECRET",
]);

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = stripSecrets(item);
  }
  return out;
}

export function publicBase(req) {
  const forwarded = req.get("x-forwarded-proto");
  const proto = forwarded ? String(forwarded).split(",")[0].trim() : req.protocol || "http";
  const hostHeader = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const host = String(hostHeader).split(",")[0].trim();
  return `${proto}://${host}`;
}

export function cleanText(value, max) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

export function cleanE164(value) {
  const phone = cleanText(value, 20).replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return "";
  return phone;
}

export function cleanWebhookUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw httpError(400, "Voice URL and status callback must be http(s) or a path on this app");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "Voice URL and status callback must be http(s) or a path on this app");
  }
  return url.toString().slice(0, 500);
}

export function page(key, items, uri, extra = {}) {
  return {
    [key]: items,
    uri,
    page: 0,
    page_size: items.length,
    first_page_uri: uri,
    next_page_uri: null,
    previous_page_uri: null,
    ...extra,
  };
}
