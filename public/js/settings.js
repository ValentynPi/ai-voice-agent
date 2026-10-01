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
  let telephony = "Open Phone Numbers.";
  try {
    const numbers = await readJson(await fetch("/api/phone-numbers"));
    const count = (numbers.incoming_phone_numbers || []).length;
    const where = numbers.source === "telephony" ? "synced from telephony" : "local store";
    telephony = numbers.mode === "connected"
      ? `Connected · ${count} number${count === 1 ? "" : "s"} (${where})`
      : `Demo · ${count} number${count === 1 ? "" : "s"} (${where})`;
  } catch {
    telephony = "Phone Numbers unavailable.";
  }
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
      ["Telephony", telephony],
    ];
    list.replaceChildren();
    for (const [label, value] of pairs) list.append(...row(label, value));
  } catch (error) {
    list.replaceChildren(...row("Status", error.message || "Could not load settings."));
  }
}

load();
