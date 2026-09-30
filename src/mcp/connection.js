import { onDatabaseReady } from "../db.js";
import {
  clearMcpTools,
  listMcpToolRows,
  readMcpConnection,
  replaceMcpTools,
  saveMcpConnection,
  setMcpToolEnabledRow,
} from "../db.js";
import { authorizeTool } from "../security.js";
import { recordSecurity, recordToolCall } from "../store.js";
import { aliasFor, openMcpSession } from "./client.js";

let live = null;

onDatabaseReady(() => {
  const current = live;
  live = null;
  if (current) current.close().catch(() => {});
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function summarize(parameters) {
  const props = parameters?.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : []);
  const names = Object.keys(props).slice(0, 12).map((key) => (required.has(key) ? `${key}*` : key));
  return names.length ? names.join(", ") : "no parameters";
}

function fitSchema(schema) {
  const source = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema
    : { type: "object", properties: {} };
  try {
    if (JSON.stringify(source).length <= 12000) return source;
  } catch {
    return { type: "object", properties: {} };
  }
  const properties = {};
  for (const [key, value] of Object.entries(source.properties || {}).slice(0, 20)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) continue;
    properties[key] = {
      type: value?.type === "number" || value?.type === "boolean" || value?.type === "integer" ? value.type : "string",
      ...(value?.description ? { description: String(value.description).slice(0, 200) } : {}),
    };
  }
  return {
    type: "object",
    properties,
    ...(Array.isArray(source.required) ? { required: source.required.filter((key) => properties[key]) } : {}),
  };
}

export function normalizeMcpTools(tools) {
  const used = new Set();
  const seen = new Set();
  const normalized = [];
  for (const tool of tools || []) {
    const name = String(tool?.name || "").trim().slice(0, 128);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const parameters = fitSchema(tool.inputSchema || tool.parameters);
    normalized.push({
      name,
      alias: aliasFor(name, used),
      description: String(tool.description || `Call the MCP tool ${name}.`).replace(/\s+/g, " ").trim().slice(0, 2000),
      parameters,
    });
  }
  return normalized;
}

function presentTool(tool) {
  return {
    name: tool.name,
    alias: tool.alias,
    description: tool.description,
    parameters: tool.parameters,
    parameterSummary: summarize(tool.parameters),
    enabled: tool.enabled !== false,
  };
}

export function publicMcp() {
  const saved = readMcpConnection();
  const tools = saved?.connected ? listMcpToolRows().map(presentTool) : [];
  if (!saved) {
    return {
      connected: false,
      url: "",
      hasToken: false,
      serverName: "",
      protocolVersion: "",
      error: "",
      tools,
    };
  }
  return {
    connected: Boolean(saved.connected),
    url: saved.url,
    hasToken: Boolean(saved.authToken),
    serverName: saved.serverName || "",
    protocolVersion: saved.protocolVersion || "",
    error: saved.error || "",
    tools,
  };
}

function remember(saved, { connected, error = "", serverName, protocolVersion, authToken, url }) {
  saveMcpConnection({
    url: url ?? saved?.url ?? "",
    authToken: authToken === undefined ? saved?.authToken || "" : authToken,
    serverName: serverName === undefined ? saved?.serverName || "" : serverName,
    protocolVersion: protocolVersion === undefined ? saved?.protocolVersion || "" : protocolVersion,
    connected,
    error,
  });
}

async function replaceLive(session, tools, authToken) {
  const previous = live;
  live = session;
  if (previous && previous !== session) await previous.close().catch(() => {});
  replaceMcpTools(normalizeMcpTools(tools));
  remember(readMcpConnection(), {
    url: session.url,
    authToken,
    serverName: session.serverName,
    protocolVersion: session.protocolVersion,
    connected: true,
    error: "",
  });
}

export async function connectMcp({ url, token } = {}) {
  const endpoint = String(url || "").trim();
  const saved = readMcpConnection();
  const secret = token == null && saved && saved.url === endpoint ? saved.authToken : String(token || "");
  let session;
  try {
    session = await openMcpSession({ url: endpoint, token: secret });
  } catch (error) {
    throw httpError(error.status && error.status < 500 ? error.status : 502, error.message || "Could not connect to the MCP server");
  }
  try {
    const tools = await session.listTools();
    await replaceLive(session, tools, secret);
  } catch (error) {
    await session.close().catch(() => {});
    throw httpError(502, error.message || "MCP server did not return tools");
  }
  return publicMcp();
}

export async function ensureMcp() {
  const saved = readMcpConnection();
  if (!saved?.connected || !saved.url) return null;
  if (live?.matches(saved.url)) return live;
  try {
    const session = await openMcpSession({ url: saved.url, token: saved.authToken });
    const tools = await session.listTools();
    await replaceLive(session, tools, saved.authToken);
    return live;
  } catch (error) {
    remember(saved, { connected: true, error: error.message || "MCP reconnect failed" });
    return null;
  }
}

export async function disconnectMcp() {
  const current = live;
  live = null;
  if (current) await current.close().catch(() => {});
  const saved = readMcpConnection();
  clearMcpTools();
  if (saved) {
    remember(saved, { connected: false, error: "", serverName: "", protocolVersion: "" });
  }
  return publicMcp();
}

export function setMcpToolEnabled(name, enabled) {
  const saved = readMcpConnection();
  if (!saved?.connected) throw httpError(409, "Connect an MCP server first");
  const ok = setMcpToolEnabledRow(name, enabled);
  if (!ok) throw httpError(404, "Tool is not on this MCP server");
  return publicMcp();
}

export function listEnabledMcpRealtimeTools() {
  const saved = readMcpConnection();
  if (!saved?.connected) return [];
  return listMcpToolRows()
    .filter((tool) => tool.enabled)
    .map((tool) => ({
      type: "function",
      name: tool.alias,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function findTool(name) {
  const wanted = String(name || "");
  return listMcpToolRows().find((tool) => tool.alias === wanted || tool.name === wanted) || null;
}

function presentResult(result) {
  if (typeof result === "string") return { text: result.slice(0, 4000), isError: false };
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return String(part.text || "");
    return "";
  }).filter(Boolean).join("\n").slice(0, 4000);
  const payload = {
    text,
    isError: Boolean(result?.isError),
    content: content.slice(0, 12).map((part) => {
      if (typeof part === "string") return { type: "text", text: part.slice(0, 2000) };
      if (part?.type === "text") return { type: "text", text: String(part.text || "").slice(0, 2000) };
      return { type: String(part?.type || "unknown") };
    }),
  };
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    payload.structured = result.structuredContent;
  }
  return payload;
}

export async function invokeMcpTool({ callId, name, args }) {
  const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const saved = readMcpConnection();
  const tool = saved?.connected ? findTool(name) : null;
  const registered = Boolean(tool?.enabled);
  const auth = authorizeTool(tool?.name || name, safeArgs, registered);
  recordSecurity({
    callId,
    kind: "tool",
    decision: auth.decision,
    summary: auth.summary,
    detail: auth.detail,
    reasonCode: auth.reasonCode,
    tool: tool?.name || name,
    excerpt: JSON.stringify(safeArgs),
  });
  const started = Date.now();
  if (auth.decision === "deny" || !tool) {
    const result = { error: auth.detail };
    recordToolCall({
      callId,
      name: tool?.name || name,
      group: "mcp",
      args: safeArgs,
      decision: "deny",
      ok: false,
      result,
      durationMs: Date.now() - started,
    });
    return { name: tool?.name || name, group: "mcp", decision: "deny", ok: false, result };
  }

  try {
    const session = await ensureMcp();
    if (!session) {
      const reason = readMcpConnection()?.error || "MCP server is not connected";
      throw new Error(reason);
    }
    const raw = await session.callTool(tool.name, safeArgs);
    const result = presentResult(raw);
    const ok = !result.isError;
    recordToolCall({
      callId,
      name: tool.name,
      group: "mcp",
      args: safeArgs,
      decision: "allow",
      ok,
      result,
      durationMs: Date.now() - started,
    });
    return { name: tool.name, group: "mcp", decision: "allow", ok, result };
  } catch (error) {
    const result = { error: error.message || "MCP tool failed" };
    recordToolCall({
      callId,
      name: tool.name,
      group: "mcp",
      args: safeArgs,
      decision: "allow",
      ok: false,
      result,
      durationMs: Date.now() - started,
    });
    return { name: tool.name, group: "mcp", decision: "allow", ok: false, result };
  }
}
