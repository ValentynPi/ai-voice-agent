import { emptyState, formatDuration, formatWhen, readJson, statusClass, statusLabel } from "./ui.js";

const list = document.querySelector("#callList");
const filter = document.querySelector("#agentFilter");

function params() {
  const agentId = new URLSearchParams(location.search).get("agentId") || "";
  return agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
}

async function loadAgents() {
  try {
    const body = await readJson(await fetch("/api/agents"));
    const selected = new URLSearchParams(location.search).get("agentId") || "";
    for (const agent of body.agents || []) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      option.selected = agent.id === selected;
      filter.append(option);
    }
  } catch {
    /* The call list can still load. */
  }
}

function render(calls) {
  list.replaceChildren();
  if (!calls.length) {
    list.append(emptyState("No calls yet", "Start a web test call from an agent. It shows up here after you hang up."));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["When", "Agent", "Duration", "Status", "Summary"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const call of calls) {
    const row = document.createElement("tr");
    const when = document.createElement("td");
    const link = document.createElement("a");
    link.href = `/history/${encodeURIComponent(call.id)}`;
    link.textContent = formatWhen(call.startedAt);
    when.append(link);
    const agent = document.createElement("td");
    agent.textContent = call.agentName || "Unknown agent";
    const duration = document.createElement("td");
    duration.textContent = formatDuration(call.durationMs);
    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `pill ${statusClass(call.status)}`;
    pill.textContent = statusLabel(call.status);
    status.append(pill);
    const summary = document.createElement("td");
    summary.className = "quiet";
    summary.textContent = call.summary || (call.status === "in_progress" ? "Live now" : "No summary");
    row.append(when, agent, duration, status, summary);
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  list.append(wrap);
}

filter.addEventListener("change", () => {
  const url = new URL(location.href);
  if (filter.value) url.searchParams.set("agentId", filter.value);
  else url.searchParams.delete("agentId");
  location.assign(url.pathname + url.search);
});

async function load() {
  try {
    const body = await readJson(await fetch(`/api/history${params()}`));
    render(body.calls || []);
  } catch (error) {
    list.replaceChildren(emptyState("History unavailable", error.message || "Could not load calls."));
  }
}

loadAgents();
load();
