/**
 * Token budget for MCP tools in a Realtime session. Every response re-reads the
 * whole tool list; the Open-Meteo MCP ships ~12k tokens of schema prose
 * (11 tools) that cost more than the whole conversation. Keep the contract
 * (names, types, enums, required, ranges) and the first sentence plus any
 * "required / at least one / must" sentence of each description.
 */
const KEEP = /\b(required|at least one|must|only one of)\b/i;
const DROP_KEYS = new Set(["$schema", "examples", "example", "default", "title", "$id", "$comment", "additionalProperties", "maxItems", "minItems"]);

function sentences(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim()
    .replace(/\b(e\.g|i\.e|etc|vs|approx)\./gi, (m) => m.replaceAll(".", "\u0000"));
  return flat.split(/(?<=[.!?])\s+(?=[A-Z"'(\u00C0-\u024F])/).map((part) => part.replaceAll("\u0000", "."));
}

export function compactDescription(text, max = 240, { keepRules = true } = {}) {
  const parts = sentences(text).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  const kept = [parts[0]];
  if (keepRules) for (const part of parts.slice(1)) if (KEEP.test(part)) kept.push(part);
  let out = kept.join(" ");
  if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
  return out;
}

export function compactSchema(node, depth = 0) {
  if (Array.isArray(node)) return node.map((item) => compactSchema(item, depth + 1));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP_KEYS.has(key)) continue;
    if (key === "pattern" && String(value).length > 40) continue;
    if (key === "description") {
      const short = compactDescription(value, 110, { keepRules: false });
      if (short) out.description = short;
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, prop]) => [name, compactSchema(prop, depth + 1)]));
      continue;
    }
    out[key] = compactSchema(value, depth + 1);
  }
  return out;
}

export function compactRealtimeTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  return {
    type: "function",
    name: tool.name,
    description: compactDescription(tool.description, 320),
    parameters: compactSchema(tool.parameters || { type: "object", properties: {} }),
  };
}

/** What the model hears back from a tool: the spoken-ready text, not 3 copies of it. */
export const TOOL_OUTPUT_MAX_CHARS = 1200;
export function compactToolOutput(result) {
  if (result == null) return {};
  if (typeof result === "string") return { text: result.slice(0, TOOL_OUTPUT_MAX_CHARS) };
  if (typeof result !== "object") return { text: String(result) };
  if (result.error && !result.text) return { error: String(result.error).slice(0, 400) };
  const text = String(result.text || "").trim();
  if (text) {
    const clipped = text.length > TOOL_OUTPUT_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : text;
    return result.isError ? { error: clipped } : { text: clipped };
  }
  const raw = JSON.stringify(result.structured ?? result);
  return { data: raw.length > TOOL_OUTPUT_MAX_CHARS ? `${raw.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : raw };
}
