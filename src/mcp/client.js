const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CLIENT_INFO = { name: "maison-sol", version: "1.0.0" };

export class McpError extends Error {
  constructor(message, status = 502, trySse = false) {
    super(message);
    this.name = "McpError";
    this.status = status;
    this.expose = true;
    this.trySse = trySse;
  }
}

export function validateMcpUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new McpError("MCP URL is not valid", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpError("MCP URL must start with http:// or https://", 400);
  }
  if (!url.hostname) throw new McpError("MCP URL is not valid", 400);
  return url.toString();
}

export function aliasFor(name, used) {
  const raw = String(name || "").trim();
  let alias = raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!alias || !/^[a-zA-Z_]/.test(alias)) alias = `tool_${alias || "unnamed"}`;
  alias = alias.slice(0, 64);
  const base = alias;
  let n = 2;
  while (used.has(alias)) {
    const suffix = `_${n}`;
    alias = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    n += 1;
  }
  used.add(alias);
  return alias;
}

function authHeaders(token) {
  const secret = String(token || "").trim();
  if (!secret) return {};
  const value = /^(Bearer|Basic)\s+/i.test(secret) ? secret : `Bearer ${secret}`;
  return { Authorization: value };
}

function redact(message, token) {
  let text = String(message || "MCP request failed").replace(/\s+/g, " ").trim().slice(0, 400);
  const secret = String(token || "").trim();
  if (secret) text = text.split(secret).join("***");
  return text || "MCP request failed";
}

function deadline(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new McpError(message, 504)), ms);
  });
  promise.catch(() => {});
  return {
    promise,
    clear() {
      clearTimeout(timer);
    },
  };
}

export async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt >= 0) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const parsed = parseSseBlock(raw);
        if (parsed) yield parsed;
        splitAt = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function parseSseBlock(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

async function readJsonOrSse(response, id, token) {
  if (response.status === 202 || response.status === 204) {
    await response.text().catch(() => "");
    return null;
  }
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    return readSseResult(response.body, id, token);
  }
  const raw = await response.text();
  if (!raw.trim()) return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new McpError(redact(raw, token), response.status || 502);
  }
  if (payload.error) {
    throw new McpError(redact(payload.error.message || "MCP request failed", token), response.ok ? 502 : response.status);
  }
  return payload.result;
}

async function readSseResult(body, id, token) {
  if (!body) throw new McpError("MCP stream was empty", 502);
  for await (const event of parseSse(body)) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (payload.id !== id) continue;
    if (payload.error) throw new McpError(redact(payload.error.message || "MCP request failed", token), 502);
    return payload.result;
  }
  throw new McpError("MCP stream ended before a result", 502);
}

class RpcSession {
  constructor(url, token, fetchImpl) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.nextId = 0;
    this.protocolVersion = "";
    this.serverName = "";
  }

  matches(url) {
    return this.url === url;
  }

  async initialize() {
    let lastError;
    for (const version of VERSIONS) {
      try {
        const result = await this.request("initialize", {
          protocolVersion: version,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        }, { offeredVersion: version });
        this.protocolVersion = result?.protocolVersion || version;
        this.serverName = String(result?.serverInfo?.name || "").slice(0, 120);
        await this.notify("notifications/initialized");
        return;
      } catch (error) {
        lastError = error;
        if (error.trySse || error.status === 401 || error.status === 403) break;
        if (!/protocol|version|unsupported/i.test(error.message || "")) break;
      }
    }
    throw lastError;
  }

  async listTools() {
    const tools = [];
    let cursor = "";
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      const page = Array.isArray(result?.tools) ? result.tools : [];
      tools.push(...page);
      cursor = result?.nextCursor || "";
    } while (cursor && tools.length < 64);
    return tools.slice(0, 64);
  }

  async callTool(name, args) {
    return this.request("tools/call", {
      name,
      arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
    });
  }

  async close() {}
}

class StreamableSession extends RpcSession {
  constructor(url, token, fetchImpl) {
    super(url, token, fetchImpl);
    this.sessionId = "";
    this.mode = "streamable";
  }

  async request(method, params, { offeredVersion } = {}) {
    const id = ++this.nextId;
    return this.post({ jsonrpc: "2.0", id, method, params: params || {} }, { id, offeredVersion });
  }

  async notify(method) {
    await this.post({ jsonrpc: "2.0", method }, { notification: true });
  }

  async post(message, { id, notification = false, offeredVersion } = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders(this.token),
    };
    const version = this.protocolVersion || offeredVersion;
    if (version) headers["MCP-Protocol-Version"] = version;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new McpError(redact(error.message || "MCP request failed", this.token), 502);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => "");
      const fallback = response.status === 404 || response.status === 405 || response.status === 406;
      throw new McpError(redact(detail || `MCP HTTP ${response.status}`, this.token), response.status, fallback);
    }
    if (notification) {
      await response.text().catch(() => "");
      return null;
    }
    const result = await readJsonOrSse(response, id, this.token);
    if (result == null) throw new McpError("MCP server did not return a result", 502);
    return result;
  }

  async close() {
    if (!this.sessionId) return;
    const headers = {
      ...authHeaders(this.token),
      "Mcp-Session-Id": this.sessionId,
    };
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* session end is best-effort */ }
    this.sessionId = "";
  }
}

class SseSession extends RpcSession {
  constructor(url, token, fetchImpl) {
    super(url, token, fetchImpl);
    this.mode = "sse";
    this.postUrl = "";
    this.controller = new AbortController();
    this.waiters = new Map();
    this.pump = null;
  }

  async initialize() {
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        headers: {
          Accept: "text/event-stream",
          ...authHeaders(this.token),
        },
        signal: this.controller.signal,
      });
    } catch (error) {
      throw new McpError(redact(error.message || "MCP SSE connection failed", this.token), 502);
    }
    if (!response.ok || !response.body) {
      throw new McpError(`MCP SSE connection failed (${response.status})`, response.status || 502);
    }
    const events = parseSse(response.body);
    const nextEvent = events.next();
    nextEvent.catch(() => {});
    const limit = deadline(8000, "MCP server did not send an SSE endpoint");
    let first;
    try {
      first = await Promise.race([nextEvent, limit.promise]);
    } finally {
      limit.clear();
    }
    if (first.done || !first.value?.data) throw new McpError("MCP SSE endpoint event was missing", 502);
    this.postUrl = new URL(first.value.data.trim(), this.url).toString();
    this.pump = this.readLoop(events);
    await super.initialize();
  }

  async readLoop(events) {
    try {
      for await (const event of events) this.dispatch(event);
      this.failAll(new McpError("MCP SSE connection closed", 502));
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.failAll(error instanceof McpError ? error : new McpError(redact(error.message, this.token), 502));
    }
  }

  dispatch(event) {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.id == null) return;
    const waiter = this.waiters.get(payload.id);
    if (!waiter) return;
    this.waiters.delete(payload.id);
    waiter(payload);
  }

  failAll(error) {
    for (const waiter of this.waiters.values()) waiter({ error: { message: error.message } });
    this.waiters.clear();
  }

  waitFor(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new McpError("MCP response timed out", 504));
      }, 20000);
      this.waiters.set(id, (payload) => {
        clearTimeout(timer);
        if (payload.error) reject(new McpError(redact(payload.error.message || "MCP request failed", this.token), 502));
        else resolve(payload.result);
      });
    });
  }

  async request(method, params, options = {}) {
    const id = ++this.nextId;
    const pending = this.waitFor(id);
    await this.post({ jsonrpc: "2.0", id, method, params: params || {} }, options);
    const result = await pending;
    if (result == null) throw new McpError("MCP server did not return a result", 502);
    return result;
  }

  async notify(method) {
    await this.post({ jsonrpc: "2.0", method }, { notification: true });
  }

  async post(message, { notification = false, offeredVersion } = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders(this.token),
    };
    const version = this.protocolVersion || offeredVersion;
    if (version) headers["MCP-Protocol-Version"] = version;
    let response;
    try {
      response = await this.fetchImpl(this.postUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new McpError(redact(error.message || "MCP request failed", this.token), 502);
    }
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => "");
      throw new McpError(redact(detail || `MCP HTTP ${response.status}`, this.token), response.status);
    }
    const type = response.headers.get("content-type") || "";
    if (!notification && type.includes("application/json")) {
      const payload = await response.json();
      if (payload?.id != null) this.dispatch({ data: JSON.stringify(payload) });
      return;
    }
    await response.text().catch(() => "");
  }

  async close() {
    this.controller.abort();
    this.failAll(new McpError("MCP session closed", 499));
  }
}

export async function openMcpSession({ url, token = "", fetchImpl = fetch } = {}) {
  const endpoint = validateMcpUrl(url);
  const streamable = new StreamableSession(endpoint, token, fetchImpl);
  try {
    await streamable.initialize();
    return streamable;
  } catch (error) {
    await streamable.close().catch(() => {});
    if (!error.trySse) throw error;
  }
  const sse = new SseSession(endpoint, token, fetchImpl);
  try {
    await sse.initialize();
    return sse;
  } catch (error) {
    await sse.close().catch(() => {});
    throw error;
  }
}
