import { chatModel, realtimeModel, voiceName } from "./models.js";
import { getSnapshot } from "./store.js";
import { getCatalog } from "./tools/demo-data.js";
import { listToolDefinitions } from "./tools/registry.js";

export function buildState() {
  const openai = Boolean(process.env.OPENAI_API_KEY);
  return {
    ...getSnapshot(),
    openai,
    model: openai ? chatModel() : null,
    realtimeModel: openai ? realtimeModel() : null,
    voice: openai ? voiceName() : null,
    catalog: getCatalog(),
    tools: listToolDefinitions().map(({ name, group, description }) => ({
      name,
      group,
      description,
    })),
  };
}
