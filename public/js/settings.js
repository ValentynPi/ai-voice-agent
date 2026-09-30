import { readJson } from "./ui.js";

const list = document.querySelector("#settings");

function row(label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  return [term, detail];
}

async function load() {
  try {
    const state = await readJson(await fetch("/api/state"));
    const pairs = [
      ["OpenAI", state.openai ? "Key configured" : "No API key on this server"],
      ["Chat model", state.model || "Unavailable without a key"],
      ["Realtime model", state.realtimeModel || "Unavailable without a key"],
      ["Default voice", state.voice || "marin"],
      ["Database", state.database?.path || "sqlite"],
      ["Database note", state.database?.note || ""],
      ["MCP", state.mcp?.connected ? `Connected · ${state.mcp.url}` : "Not connected"],
      ["MCP token", state.mcp?.hasToken ? "Stored on the server" : "None stored"],
      ["Telephony", "Not in this phase. Twilio and SIP stay on the Phone Numbers page."],
    ];
    list.replaceChildren();
    for (const [label, value] of pairs) list.append(...row(label, value));
  } catch (error) {
    list.replaceChildren(...row("Status", error.message || "Could not load settings."));
  }
}

load();
