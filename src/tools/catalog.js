import { onDatabaseReady, databaseInfo, deleteToolRow, getToolRow, insertBuiltinTool, insertCustomTool, listToolRows, updateToolRow } from "../db.js";

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const CUSTOM_GROUPS = new Set(["orders", "crm", "database"]);

let builtins = [];

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

export function registerBuiltinTools(list) {
  builtins = list.map((tool) => ({
    name: tool.name,
    group: tool.group,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function syncBuiltinTools() {
  for (const tool of builtins) insertBuiltinTool(tool);
}

onDatabaseReady(() => {
  if (builtins.length) syncBuiltinTools();
});

export function resetToolCatalog() {
  for (const row of listToolRows()) {
    if (!row.builtin) deleteToolRow(row.name);
  }
  for (const tool of builtins) {
    updateToolRow(tool.name, { description: tool.description, enabled: true, parameters: tool.parameters });
  }
}

export function initToolCatalog() {
  syncBuiltinTools();
  return toolCatalogInfo();
}

export function toolCatalogInfo() {
  const info = databaseInfo();
  return {
    memory: info.memory,
    database: info.driver,
    file: info.path,
    saved: !info.memory,
    note: info.memory
      ? "Tool edits are stored in the in-memory SQLite database for this process."
      : "Tool edits are stored in SQLite (tool_definitions). Set DATABASE_PATH. On Fly, attach a volume or the file is lost when the machine stops.",
  };
}

function builtinNamed(name) {
  return builtins.find((tool) => tool.name === name) || null;
}

function cleanDescription(value) {
  const description = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
  if (!description) throw httpError(400, "Description is required");
  if (description.length > 800) throw httpError(400, "Description is too long");
  return description;
}

function sanitizeProps(properties) {
  const entries = Object.entries(properties || {});
  if (entries.length > 12) throw httpError(400, "Too many parameters");
  const next = {};
  for (const [key, schema] of entries) {
    if (!NAME_RE.test(key)) throw httpError(400, "Parameter names must be short snake_case");
    const type = schema?.type === "number" || schema?.type === "boolean" ? schema.type : "string";
    const property = { type };
    if (typeof schema?.description === "string" && schema.description.trim()) {
      property.description = schema.description.trim().slice(0, 200);
    }
    next[key] = property;
  }
  return next;
}

function parametersFrom(parameters, fields) {
  if (Array.isArray(fields)) {
    const properties = {};
    for (const field of fields) {
      const name = String(field || "").trim();
      if (!name) continue;
      if (!NAME_RE.test(name)) throw httpError(400, "Parameter names must be short snake_case");
      properties[name] = { type: "string" };
    }
    return { type: "object", additionalProperties: false, properties };
  }
  if (parameters == null) {
    return { type: "object", additionalProperties: false, properties: {} };
  }
  if (typeof parameters !== "object" || Array.isArray(parameters) || parameters.type !== "object") {
    throw httpError(400, "parameters must be an object schema");
  }
  const properties = sanitizeProps(parameters.properties);
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((key) => properties[key])
    : undefined;
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required?.length ? { required } : {}),
  };
}

function sanitizeMock(mock) {
  if (mock == null) return { ok: true, message: "Mock salon note." };
  if (typeof mock !== "object" || Array.isArray(mock)) throw httpError(400, "mock must be a JSON object");
  let raw;
  try {
    raw = JSON.stringify(mock);
  } catch {
    throw httpError(400, "mock must be JSON");
  }
  if (raw.length > 4000) throw httpError(400, "mock is too large");
  return JSON.parse(raw);
}

export function summarizeParameters(parameters) {
  const properties = parameters?.properties || {};
  const required = new Set(parameters?.required || []);
  const parts = Object.entries(properties).map(([key, schema]) => {
    const type = schema?.type || "any";
    return `${key}: ${type}${required.has(key) ? " required" : ""}`;
  });
  return parts.length ? parts.join(", ") : "no parameters";
}

export function overlayForBuiltin(name, fallbackDescription) {
  syncBuiltinTools();
  const row = getToolRow(name);
  if (!row) return { description: fallbackDescription, enabled: true };
  return { description: row.description || fallbackDescription, enabled: row.enabled };
}

export function customToolRecords() {
  syncBuiltinTools();
  return listToolRows()
    .filter((tool) => !tool.builtin)
    .map((tool) => ({
      ...tool,
      mock: structuredClone(tool.mock),
      parameters: structuredClone(tool.parameters),
    }));
}

export function updateTool(name, patch) {
  syncBuiltinTools();
  const builtin = builtinNamed(name);
  const row = getToolRow(name);
  if (!builtin && !row) throw httpError(404, "Tool not found");
  const next = {
    description: row?.description,
    enabled: row ? row.enabled : true,
    parameters: row?.parameters || builtin?.parameters,
    mock: row?.mock,
  };
  if (patch.description != null) next.description = cleanDescription(patch.description);
  if (patch.enabled != null) {
    if (typeof patch.enabled !== "boolean") throw httpError(400, "enabled must be true or false");
    next.enabled = patch.enabled;
  }
  if (patch.mock != null) {
    if (builtin) throw httpError(400, "Built-in tools keep their handlers. Weather stays on Open-Meteo.");
    next.mock = sanitizeMock(patch.mock);
  }
  if (patch.fields != null || patch.parameters != null) {
    if (builtin) throw httpError(400, "Built-in tool parameters stay fixed.");
    next.parameters = parametersFrom(patch.parameters, patch.fields);
  }
  updateToolRow(name, next);
  return true;
}

export function createCustomTool(input) {
  syncBuiltinTools();
  const name = String(input?.name || "").trim();
  if (!NAME_RE.test(name)) throw httpError(400, "Name must be short snake_case");
  if (builtinNamed(name) || getToolRow(name)) throw httpError(409, "A tool with that name already exists");
  const group = String(input?.group || "");
  if (!CUSTOM_GROUPS.has(group)) {
    throw httpError(400, "Custom tools can use orders, crm, or database. Weather stays on Open-Meteo.");
  }
  insertCustomTool({
    name,
    group,
    description: cleanDescription(input?.description),
    enabled: input?.enabled !== false,
    parameters: parametersFrom(input?.parameters, input?.fields),
    mock: sanitizeMock(input?.mock),
  });
  return true;
}

export function removeCustomTool(name) {
  syncBuiltinTools();
  const builtin = builtinNamed(name);
  if (builtin) {
    const message = builtin.group === "weather"
      ? "Weather tools stay registered so Castellón forecasts keep working. Disable one instead of removing it."
      : "Built-in tools can be disabled, not removed.";
    throw httpError(400, message);
  }
  if (!deleteToolRow(name)) throw httpError(404, "Tool not found");
}
