import { authorizeTool } from "../security.js";
import { recordSecurity, recordToolCall } from "../store.js";
import {
  createCustomTool,
  customToolRecords,
  overlayForBuiltin,
  registerBuiltinTools,
  removeCustomTool,
  summarizeParameters,
  updateTool,
} from "./catalog.js";
import { getForecast, getWeather } from "./weather.js";
import {
  getOrder,
  listAppointments,
  listOrders,
  lookupCustomer,
  queryHours,
  queryServices,
  queryStaff,
  bookAppointment,
} from "./salon.js";

const objectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const TOOLS = [
  {
    name: "get_weather",
    group: "weather",
    description: "Current weather in Castellón de la Plana from Open-Meteo.",
    parameters: objectSchema,
    handler: () => getWeather(),
  },
  {
    name: "get_forecast",
    group: "weather",
    description: "Multi-day forecast for Castellón de la Plana from Open-Meteo.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: { type: "number", description: "Number of days, 1 to 4." },
      },
    },
    handler: (args) => getForecast(args),
  },
  {
    name: "list_orders",
    group: "orders",
    description: "List fictional salon orders. Optional status: confirmed, pending, or completed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string" },
      },
    },
    handler: (args) => listOrders(args),
  },
  {
    name: "get_order",
    group: "orders",
    description: "Look up one fictional salon order by id (for example ORD-1042) or customer name.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        customer: { type: "string" },
      },
    },
    handler: (args) => getOrder(args),
  },
  {
    name: "lookup_customer",
    group: "crm",
    description: "Look up a fictional CRM client by name. Includes the next appointment.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    handler: (args) => lookupCustomer(args),
  },
  {
    name: "list_appointments",
    group: "crm",
    description: "List upcoming fictional appointments in the salon book.",
    parameters: objectSchema,
    handler: () => listAppointments(),
  },
  {
    name: "query_services",
    group: "database",
    description: "List fictional salon services and prices.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        q: { type: "string" },
      },
    },
    handler: (args) => queryServices(args),
  },
  {
    name: "query_staff",
    group: "database",
    description: "List fictional stylists at Maison Sol.",
    parameters: objectSchema,
    handler: () => queryStaff(),
  },
  {
    name: "query_hours",
    group: "database",
    description: "Opening hours for the fictional Maison Sol salon.",
    parameters: objectSchema,
    handler: () => queryHours(),
  },
  {
    name: "book_appointment",
    group: "crm",
    description: "Book a fictional appointment and pending order for an existing Maison Sol client. Writes the salon database.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        customer: { type: "string", description: "Existing client name." },
        service: { type: "string", description: "Service name from the salon menu." },
        date: { type: "string", description: "Date as YYYY-MM-DD." },
        time: { type: "string", description: "Time as HH:MM." },
        stylist: { type: "string", description: "Optional stylist name." },
      },
      required: ["customer", "service", "date", "time"],
    },
    handler: (args) => bookAppointment(args),
  },
];

registerBuiltinTools(TOOLS);

function runtimeTools() {
  const builtin = TOOLS.map((tool) => {
    const overlay = overlayForBuiltin(tool.name, tool.description);
    return {
      ...tool,
      description: overlay.description,
      enabled: overlay.enabled,
      builtin: true,
    };
  });
  const custom = customToolRecords().map((tool) => ({
    name: tool.name,
    group: tool.group,
    description: tool.description,
    parameters: tool.parameters,
    enabled: tool.enabled !== false,
    builtin: false,
    mock: tool.mock,
    handler: () => structuredClone(tool.mock),
  }));
  return [...builtin, ...custom];
}

function publicTool(tool) {
  return {
    name: tool.name,
    group: tool.group,
    description: tool.description,
    parameters: tool.parameters,
    parameterSummary: summarizeParameters(tool.parameters),
    enabled: tool.enabled !== false,
    builtin: Boolean(tool.builtin),
    ...(tool.builtin ? {} : { mock: tool.mock }),
  };
}

export function listToolCatalog() {
  return runtimeTools().map(publicTool);
}

export function listToolDefinitions() {
  return listToolCatalog()
    .filter((tool) => tool.enabled)
    .map(({ name, group, description, parameters }) => ({
      name,
      group,
      description,
      parameters,
    }));
}

export function isToolEnabled(name) {
  return runtimeTools().some((tool) => tool.name === name && tool.enabled);
}

export function openaiToolSpecs() {
  return listToolDefinitions().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export { createCustomTool, removeCustomTool, updateTool };

export async function executeTool({ callId, name, args }) {
  const tool = runtimeTools().find((item) => item.name === name && item.enabled);
  const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const auth = authorizeTool(name, safeArgs, Boolean(tool));
  recordSecurity({
    callId,
    kind: "tool",
    decision: auth.decision,
    summary: auth.summary,
    detail: auth.detail,
    reasonCode: auth.reasonCode,
    tool: name,
    excerpt: JSON.stringify(safeArgs),
  });

  const started = Date.now();
  if (auth.decision === "deny" || !tool) {
    const result = { error: auth.detail };
    recordToolCall({
      callId,
      name,
      group: tool?.group || "unknown",
      args: safeArgs,
      decision: "deny",
      ok: false,
      result,
      durationMs: Date.now() - started,
    });
    return { name, group: tool?.group || "unknown", decision: "deny", ok: false, result };
  }

  try {
    const result = await tool.handler(safeArgs);
    recordToolCall({
      callId,
      name,
      group: tool.group,
      args: safeArgs,
      decision: "allow",
      ok: true,
      result,
      durationMs: Date.now() - started,
    });
    return { name, group: tool.group, decision: "allow", ok: true, result };
  } catch (error) {
    const result = { error: error.message || "Tool failed" };
    recordToolCall({
      callId,
      name,
      group: tool.group,
      args: safeArgs,
      decision: "allow",
      ok: false,
      result,
      durationMs: Date.now() - started,
    });
    return { name, group: tool.group, decision: "allow", ok: false, result };
  }
}
