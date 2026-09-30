import { databaseInfo } from "./db.js";
import { publicMcp } from "./mcp/connection.js";
import { chatModel, realtimeModel, voiceName } from "./models.js";
import { getSnapshot } from "./store.js";
import { toolCatalogInfo } from "./tools/catalog.js";
import { listToolCatalog } from "./tools/registry.js";

export function buildState() {
  const openai = Boolean(process.env.OPENAI_API_KEY);
  return {
    ...getSnapshot(),
    openai,
    model: openai ? chatModel() : null,
    realtimeModel: openai ? realtimeModel() : null,
    voice: openai ? voiceName() : null,
    database: databaseInfo(),
    tools: listToolCatalog(),
    toolStorage: toolCatalogInfo(),
    mcp: publicMcp(),
  };
}
