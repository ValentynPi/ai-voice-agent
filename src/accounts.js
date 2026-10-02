import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";

export const DEMO_ACCOUNT_ID = "acct_demo";
export const SESSION_COOKIE = "vd_session";
const SESSION_DAYS = 30;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function cleanEmail(value) {
  const email = String(value ?? "").trim().toLowerCase().slice(0, 190);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, "Enter a valid email address");
  }
  return email;
}

function cleanName(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, 80);
}

function cleanPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128) {
    throw httpError(400, "Password must be 8 to 128 characters");
  }
  return password;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  const actual = scryptSync(password, salt, 64).toString("hex");
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Unusable hash for the public demo account (sign-in uses demo password only if set). */
function demoPasswordHash() {
  return hashPassword(randomBytes(24).toString("hex"));
}

export function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || "",
    isDemo: Boolean(row.is_demo),
    createdAt: row.created_at,
  };
}

export function getAccount(id) {
  const row = getDb().prepare(`
    SELECT id, email, name, is_demo, created_at FROM accounts WHERE id = ?
  `).get(id);
  return publicAccount(row);
}

export function getAccountByEmail(email) {
  const row = getDb().prepare(`
    SELECT id, email, name, is_demo, created_at, password_hash
    FROM accounts WHERE email = ?
  `).get(cleanEmail(email));
  return row || null;
}

export function ensureDemoAccount(database = getDb()) {
  const existing = database.prepare("SELECT id FROM accounts WHERE id = ?").get(DEMO_ACCOUNT_ID);
  if (existing) return DEMO_ACCOUNT_ID;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO accounts (id, email, password_hash, name, is_demo, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(DEMO_ACCOUNT_ID, "demo@voicedesk.local", demoPasswordHash(), "Maison Sol demo", now);
  return DEMO_ACCOUNT_ID;
}

/**
 * Create a tenant. New accounts start with no agents / knowledge / numbers.
 * Pass passwordHash to mirror an account from the sibling host (sync).
 */
export function createAccount({ email, password, name = "", passwordHash = null, id = null, isDemo = false } = {}) {
  const clean = cleanEmail(email);
  const known = getDb().prepare("SELECT id FROM accounts WHERE email = ?").get(clean);
  if (known) throw httpError(409, "An account with that email already exists");
  const accountId = id && /^acct_[a-z0-9]+$/i.test(id) ? id : newId("acct");
  if (isDemo && accountId !== DEMO_ACCOUNT_ID) {
    throw httpError(400, "Only the built-in demo account may be marked demo");
  }
  const hash = passwordHash || hashPassword(cleanPassword(password));
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO accounts (id, email, password_hash, name, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, clean, hash, cleanName(name) || clean.split("@")[0], isDemo ? 1 : 0, now);
  return getAccount(accountId);
}

/** Upsert by id for cross-host sync (Agents → telephony). Does not overwrite password if email clashes on another id. */
export function upsertSyncedAccount({ id, email, passwordHash, name = "" }) {
  if (!id || !/^acct_[a-z0-9]+$/i.test(id)) throw httpError(400, "Invalid account id");
  if (!passwordHash || !String(passwordHash).startsWith("scrypt$")) {
    throw httpError(400, "Invalid password hash");
  }
  const clean = cleanEmail(email);
  const byId = getDb().prepare("SELECT id FROM accounts WHERE id = ?").get(id);
  const byEmail = getDb().prepare("SELECT id FROM accounts WHERE email = ?").get(clean);
  if (byEmail && byEmail.id !== id) throw httpError(409, "Email already registered on another account");
  const now = new Date().toISOString();
  if (byId) {
    getDb().prepare(`
      UPDATE accounts SET email = ?, password_hash = ?, name = ? WHERE id = ?
    `).run(clean, passwordHash, cleanName(name) || clean.split("@")[0], id);
  } else {
    getDb().prepare(`
      INSERT INTO accounts (id, email, password_hash, name, is_demo, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(id, clean, passwordHash, cleanName(name) || clean.split("@")[0], now);
  }
  return getAccount(id);
}

export function authenticateAccount(email, password) {
  const row = getAccountByEmail(email);
  if (!row || row.is_demo) throw httpError(401, "Email or password is incorrect");
  if (!verifyPassword(cleanPassword(password), row.password_hash)) {
    throw httpError(401, "Email or password is incorrect");
  }
  return getAccount(row.id);
}

export function createSession(accountId) {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  getDb().prepare(`
    INSERT INTO sessions (token, account_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, accountId, expires.toISOString(), now.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

export function destroySession(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function accountFromSessionToken(token) {
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const row = getDb().prepare(`
    SELECT a.id, a.email, a.name, a.is_demo, a.created_at, s.expires_at
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    destroySession(token);
    return null;
  }
  return publicAccount(row);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function sessionCookieValue(req) {
  return parseCookies(req.get("cookie"))[SESSION_COOKIE] || "";
}

export function setSessionCookie(res, token, { secure = false } = {}) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res, { secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function cookieSecure(req) {
  if (process.env.NODE_ENV === "production") return true;
  return Boolean(req.secure || req.get("x-forwarded-proto") === "https");
}

/** Resolve the active tenant: signed-in account, or public demo when anonymous. */
export function resolveAccountId(req) {
  if (req.account?.id) return req.account.id;
  return DEMO_ACCOUNT_ID;
}

/** Built-in salon tools are removed from the product. Tools come from MCP only. */
export function includeDemoBuiltins(_accountId) {
  return false;
}

export function attachAccount(req, _res, next) {
  try {
    const token = sessionCookieValue(req);
    req.sessionToken = token || null;
    req.account = token ? accountFromSessionToken(token) : null;
    req.accountId = req.account?.id || DEMO_ACCOUNT_ID;
    req.isDemoMode = !req.account || Boolean(req.account.isDemo);
    next();
  } catch (error) {
    next(error);
  }
}

export function passwordHashFor(accountId) {
  const row = getDb().prepare("SELECT password_hash FROM accounts WHERE id = ?").get(accountId);
  return row?.password_hash || null;
}

/** Stable fingerprint for logs (never the password or raw token). */
export function accountFingerprint(email) {
  return createHash("sha256").update(String(email || "").toLowerCase()).digest("hex").slice(0, 12);
}
