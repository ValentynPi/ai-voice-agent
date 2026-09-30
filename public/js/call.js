import { emptyState, formatDuration, formatWhen, readJson, statusClass, statusLabel } from "./ui.js";

const id = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
const title = document.querySelector("#title");
const summary = document.querySelector("#summary");
const meta = document.querySelector("#meta");
const transcript = document.querySelector("#transcript");
const agentLink = document.querySelector("#agentLink");

function pill(text, tone) {
  const el = document.createElement("span");
  el.className = `pill ${tone || ""}`;
  el.textContent = text;
  return el;
}

function render(call) {
  title.textContent = call.agentName || "Call";
  document.title = `${title.textContent} · Voice Desk`;
  summary.textContent = call.summary || "No post-call summary.";
  if (call.agentId) agentLink.href = `/agents/${encodeURIComponent(call.agentId)}`;
  meta.replaceChildren(
    pill(statusLabel(call.status), statusClass(call.status)),
    pill(formatDuration(call.durationMs)),
    pill(formatWhen(call.startedAt)),
    pill(call.voice || "voice"),
  );
  transcript.replaceChildren();
  const turns = call.transcript || [];
  if (!turns.length) {
    transcript.append(emptyState("Empty transcript", "Nothing was captured before the call ended."));
    return;
  }
  for (const message of turns) {
    const item = document.createElement("li");
    item.className = `bubble ${message.role === "user" ? "user" : "assistant"}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = message.role === "user" ? "Caller" : (call.agentName || "Agent");
    const body = document.createElement("p");
    body.textContent = message.text || "";
    item.append(who, body);
    if (message.tools?.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const tool of message.tools) {
        const tag = document.createElement("span");
        tag.className = `tag ${tool.decision === "deny" || tool.ok === false ? "bad" : "ok"}`;
        tag.textContent = tool.name;
        tags.append(tag);
      }
      item.append(tags);
    }
    transcript.append(item);
  }
}

async function load() {
  try {
    const body = await readJson(await fetch(`/api/history/${encodeURIComponent(id)}`));
    render(body.call);
  } catch (error) {
    title.textContent = "Call not found";
    summary.textContent = error.message || "This call is not in history.";
    transcript.replaceChildren(emptyState("No transcript", "The call may still be open, or it was never saved."));
  }
}

load();
