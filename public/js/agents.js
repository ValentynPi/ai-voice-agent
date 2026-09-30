import { emptyState, formatWhen, readJson } from "./ui.js";

const list = document.querySelector("#agentList");
const errorEl = document.querySelector("#error");

function languageLabel(language) {
  if (language === "es") return "Spanish";
  if (language === "en") return "English";
  return "Caller language";
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

async function load() {
  try {
    const body = await readJson(await fetch("/api/agents"));
    render(body.agents || []);
  } catch (error) {
    list.replaceChildren(emptyState("Agents unavailable", error.message || "Could not load agents."));
  }
}

function render(agents) {
  list.replaceChildren();
  if (!agents.length) {
    list.append(emptyState("No agents yet", "Create one to give it a prompt, a greeting, and a web test call."));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Agent", "Voice", "Language", "Knowledge", "Updated", ""]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const agent of agents) body.append(row(agent));
  table.append(head, body);
  wrap.append(table);
  list.append(wrap);
}

function row(agent) {
  const tr = document.createElement("tr");
  const name = document.createElement("td");
  const block = document.createElement("div");
  block.className = "name-cell";
  const link = document.createElement("a");
  link.href = `/agents/${encodeURIComponent(agent.id)}`;
  link.textContent = agent.name;
  const desc = document.createElement("span");
  desc.textContent = agent.description || "No description";
  block.append(link, desc);
  name.append(block);

  const voice = document.createElement("td");
  voice.textContent = agent.voice || "marin";
  const language = document.createElement("td");
  language.textContent = languageLabel(agent.language);
  const knowledge = document.createElement("td");
  const count = agent.knowledgeIds?.length || 0;
  knowledge.textContent = count ? String(count) : "None";
  const updated = document.createElement("td");
  updated.className = "quiet";
  updated.textContent = formatWhen(agent.updatedAt);

  const actions = document.createElement("td");
  const group = document.createElement("div");
  group.className = "row-actions";
  const test = document.createElement("a");
  test.className = "btn small primary";
  test.href = `/agents/${encodeURIComponent(agent.id)}/test`;
  test.textContent = "Test call";
  const edit = document.createElement("a");
  edit.className = "btn small ghost";
  edit.href = `/agents/${encodeURIComponent(agent.id)}`;
  edit.textContent = "Edit";
  const copy = document.createElement("button");
  copy.className = "btn small ghost";
  copy.type = "button";
  copy.textContent = "Duplicate";
  copy.addEventListener("click", () => duplicate(agent.id));
  const remove = document.createElement("button");
  remove.className = "btn small danger";
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => removeAgent(agent));
  group.append(test, edit, copy, remove);
  actions.append(group);
  tr.append(name, voice, language, knowledge, updated, actions);
  return tr;
}

async function duplicate(id) {
  errorEl.hidden = true;
  try {
    const body = await readJson(await fetch(`/api/agents/${encodeURIComponent(id)}/duplicate`, { method: "POST" }));
    location.assign(`/agents/${encodeURIComponent(body.agent.id)}`);
  } catch (error) {
    showError(error.message);
  }
}

async function removeAgent(agent) {
  if (!window.confirm(`Delete ${agent.name}? Past calls stay in history.`)) return;
  errorEl.hidden = true;
  try {
    await readJson(await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" }));
    await load();
  } catch (error) {
    showError(error.message);
  }
}

load();
