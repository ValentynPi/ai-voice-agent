import { getSnapshot } from "./store.js";
import { getCatalog } from "./tools/demo-data.js";
import { listToolDefinitions } from "./tools/registry.js";

export function buildState() {
  return {
    ...getSnapshot(),
    openai: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_API_KEY ? process.env.OPENAI_MODEL || "gpt-4o-mini" : null,
    catalog: getCatalog(),
    tools: listToolDefinitions().map(({ name, group, description }) => ({
      name,
      group,
      description,
    })),
  };
}
