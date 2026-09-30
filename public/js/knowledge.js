import { emptyState, readJson } from "./ui.js";

const form = document.querySelector("#kbForm");
const formTitle = document.querySelector("#formTitle");
const titleInput = document.querySelector("#title");
const bodyInput = document.querySelector("#body");
const urlInput = document.querySelector("#sourceUrl");
const cancelBtn = document.querySelector("#cancelKb");
const saveBtn = document.querySelector("#saveKb");
const list = document.querySelector("#kbList");
const banner = document.querySelector("#banner");
let editing = "";

function note(message, tone) {
  banner.hidden = !message;
  banner.className = `banner ${tone || ""}`;
  banner.textContent = message || "";
}

function resetForm() {
  editing = "";
  form.reset();
  formTitle.textContent = "New entry";
  saveBtn.textContent = "Save entry";
  cancelBtn.hidden = true;
}

function edit(entry) {
  editing = entry.id;
  titleInput.value = entry.title;
  bodyInput.value = entry.body;
  urlInput.value = entry.sourceUrl || "";
  formTitle.textContent = "Edit entry";
  saveBtn.textContent = "Save changes";
  cancelBtn.hidden = false;
  titleInput.focus();
}

function render(entries) {
  list.replaceChildren();
  if (!entries.length) {
    list.append(emptyState("No knowledge yet", "Add a title and the text the agent should use. Attach it from the agent page."));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Entry", "Used by", "Source", ""]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const entry of entries) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const block = document.createElement("div");
    block.className = "name-cell";
    const strong = document.createElement("strong");
    strong.textContent = entry.title;
    const preview = document.createElement("span");
    preview.textContent = entry.body.replace(/\s+/g, " ").slice(0, 140);
    block.append(strong, preview);
    name.append(block);
    const used = document.createElement("td");
    used.textContent = (entry.agents || []).map((agent) => agent.name).join(", ") || "Not attached";
    const source = document.createElement("td");
    source.className = "quiet";
    source.textContent = entry.sourceUrl ? "URL saved · crawl later" : "Pasted text";
    const actions = document.createElement("td");
    const group = document.createElement("div");
    group.className = "row-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "btn small ghost";
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => edit(entry));
    const remove = document.createElement("button");
    remove.className = "btn small danger";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => removeEntry(entry));
    group.append(editBtn, remove);
    actions.append(group);
    row.append(name, used, source, actions);
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  list.append(wrap);
}

async function load() {
  try {
    const body = await readJson(await fetch("/api/knowledge"));
    render(body.knowledge || []);
  } catch (error) {
    list.replaceChildren(emptyState("Knowledge unavailable", error.message || "Could not load entries."));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveBtn.disabled = true;
  note("");
  try {
    const payload = { title: titleInput.value, body: bodyInput.value, sourceUrl: urlInput.value };
    const response = await fetch(editing ? `/api/knowledge/${encodeURIComponent(editing)}` : "/api/knowledge", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await readJson(response);
    const wasEdit = Boolean(editing);
    resetForm();
    note(wasEdit ? "Saved." : "Entry added. Attach it on an agent.", "ok");
    await load();
  } catch (error) {
    note(error.message || "Could not save.", "error");
  } finally {
    saveBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => {
  resetForm();
  note("");
});

async function removeEntry(entry) {
  if (!window.confirm(`Delete “${entry.title}”? Agents will stop using it.`)) return;
  try {
    await readJson(await fetch(`/api/knowledge/${encodeURIComponent(entry.id)}`, { method: "DELETE" }));
    if (editing === entry.id) resetForm();
    note("Deleted.", "ok");
    await load();
  } catch (error) {
    note(error.message, "error");
  }
}

load();
