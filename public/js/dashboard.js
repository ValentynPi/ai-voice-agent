let latest = null;
let signature = "";
let mcpSignature = "";

const statusPill = document.querySelector("#statusPill");
const security = document.querySelector("#security");
const mcpStatus = document.querySelector("#mcpStatus");
const mcpForm = document.querySelector("#mcpForm");
const mcpUrl = document.querySelector("#mcpUrl");
const mcpToken = document.querySelector("#mcpToken");
const mcpConnect = document.querySelector("#mcpConnect");
const mcpDisconnect = document.querySelector("#mcpDisconnect");
const mcpMessage = document.querySelector("#mcpMessage");
const mcpTools = document.querySelector("#mcpTools");
const mcpCalls = document.querySelector("#mcpCalls");
const updated = document.querySelector("#updated");

async function poll() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("bad status");
    const data = await response.json();
    const next = JSON.stringify(data);
    latest = data;
    if (next !== signature) {
      signature = next;
      render(data);
    }
    setOnline(true);
    updated.textContent = `updated ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch {
    setOnline(false);
    updated.textContent = "dashboard offline";
  }
}

function setOnline(online) {
  if (!statusPill) return;
  statusPill.classList.toggle("offline", !online);
  if (statusPill.lastChild) statusPill.lastChild.textContent = online ? " Online" : " Offline";
}

function render(data) {
  renderSecurity(data.securityEvents || []);
  renderMcp(data.mcp || {}, data.toolCalls || []);
}

function renderSecurity(events) {
  security.replaceChildren();
  if (!events.length) {
    security.append(note("No checks yet."));
    return;
  }
  for (const event of events.slice(0, 12)) {
    const item = document.createElement("li");
    item.className = "event";
    const pill = document.createElement("span");
    pill.className = `pill ${event.decision === "deny" ? "bad" : "ok"}`;
    pill.textContent = event.decision;
    const kind = document.createElement("span");
    kind.className = "tag";
    kind.textContent = event.kind === "tool" ? event.tool || "tool" : "input";
    const summary = document.createElement("p");
    summary.textContent = event.summary;
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = `${event.detail}${event.excerpt ? ` “${event.excerpt}”` : ""}`;
    const time = document.createElement("time");
    time.dateTime = event.at;
    time.textContent = clock(event.at);
    item.append(pill, kind, summary, detail, time);
    security.append(item);
  }
}

function mcpBusy() {
  const active = document.activeElement;
  return Boolean(active && mcpForm.contains(active));
}

function renderMcp(mcp, calls) {
  const connected = Boolean(mcp.connected);
  mcpStatus.textContent = connected
    ? `Connected${mcp.serverName ? ` · ${mcp.serverName}` : ""}`
    : "Not connected";
  mcpDisconnect.disabled = !connected && !mcp.url;
  if (!mcpBusy()) {
    if (mcp.url && mcpUrl.value !== mcp.url) mcpUrl.value = mcp.url;
    mcpToken.placeholder = mcp.hasToken
      ? "Token saved — leave blank to keep it"
      : "Bearer token if the server requires one";
  }
  if (mcp.error) mcpMessage.textContent = mcp.error;
  else if (connected) mcpMessage.textContent = "Enabled tools are offered to Sol on the next call.";
  else mcpMessage.textContent = "Not connected. Sol will greet, but she has no tools until you connect one.";

  const nextSignature = JSON.stringify(mcp.tools || []);
  if (nextSignature !== mcpSignature) {
    mcpSignature = nextSignature;
    renderMcpTools(mcp.tools || []);
  }
  renderMcpCalls(calls);
}

function renderMcpTools(tools) {
  mcpTools.replaceChildren();
  if (!tools.length) {
    const empty = document.createElement("p");
    empty.className = "desc";
    empty.textContent = "No tools discovered yet.";
    mcpTools.append(empty);
    return;
  }
  for (const tool of tools) mcpTools.append(mcpToolRow(tool));
}

function mcpToolRow(tool) {
  const row = document.createElement("article");
  row.className = tool.enabled === false ? "tool-row off" : "tool-row";
  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = tool.name;
  const meta = document.createElement("span");
  meta.className = "tag";
  meta.textContent = tool.alias && tool.alias !== tool.name ? tool.alias : "mcp";
  header.append(title, meta);
  const schema = document.createElement("p");
  schema.className = "schema";
  schema.textContent = tool.parameterSummary || "no parameters";
  const description = document.createElement("p");
  description.className = "desc";
  description.textContent = tool.description || "";
  const actions = document.createElement("div");
  actions.className = "tool-actions";
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "toggle";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = tool.enabled !== false;
  const caption = document.createTextNode(toggle.checked ? "Enabled" : "Disabled");
  toggle.addEventListener("change", () => {
    caption.textContent = toggle.checked ? "Enabled" : "Disabled";
    saveMcpTool(tool.name, toggle.checked, toggle);
  });
  toggleLabel.append(toggle, caption);
  actions.append(toggleLabel);
  row.append(header, schema, description, actions);
  return row;
}

function renderMcpCalls(calls) {
  mcpCalls.replaceChildren();
  const logs = (calls || []).filter((log) => log.group === "mcp").slice(0, 6);
  if (!logs.length) {
    const empty = document.createElement("p");
    empty.className = "desc";
    empty.textContent = "No calls yet";
    mcpCalls.append(empty);
    return;
  }
  for (const log of logs) mcpCalls.append(logItem(log));
}

function logItem(log) {
  const row = document.createElement("div");
  row.className = "log-item";
  const strong = document.createElement("strong");
  strong.textContent = `${log.name} · ${log.decision}`;
  const span = document.createElement("div");
  span.textContent = `${clock(log.at)} · ${log.durationMs} ms · ${log.ok ? "ok" : "blocked or failed"}`;
  const pre = document.createElement("pre");
  pre.className = "snippet";
  pre.textContent = JSON.stringify(log.result, null, 2);
  row.append(strong, span, pre);
  return row;
}

async function saveMcpTool(name, enabled, toggle) {
  mcpMessage.textContent = "Saving…";
  try {
    const response = await fetch(`/api/mcp/tools/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not update the tool");
    mcpMessage.textContent = enabled
      ? "Enabled. The next call can use this tool."
      : "Disabled. The next call will not offer this tool.";
    await refresh();
  } catch (error) {
    toggle.checked = !enabled;
    mcpMessage.textContent = error.message || "Could not update the tool";
  }
}

async function refresh() {
  const response = await fetch("/api/state");
  if (!response.ok) return;
  const data = await response.json();
  latest = data;
  signature = JSON.stringify(data);
  mcpSignature = "";
  render(data);
}

mcpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = mcpUrl.value.trim();
  const token = mcpToken.value.trim();
  mcpConnect.disabled = true;
  mcpMessage.textContent = "Connecting…";
  try {
    const response = await fetch("/api/mcp/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(token ? { url, token } : { url }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not connect");
    mcpToken.value = "";
    const count = body.mcp?.tools?.length || 0;
    mcpMessage.textContent = `Connected. Discovered ${count} tool${count === 1 ? "" : "s"}.`;
    await refresh();
  } catch (error) {
    mcpMessage.textContent = error.message || "Could not connect";
  } finally {
    mcpConnect.disabled = false;
  }
});

mcpDisconnect.addEventListener("click", async () => {
  mcpDisconnect.disabled = true;
  mcpMessage.textContent = "Disconnecting…";
  try {
    const response = await fetch("/api/mcp/disconnect", { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not disconnect");
    mcpToken.value = "";
    mcpMessage.textContent = "Disconnected. Sol will not call those tools.";
    await refresh();
  } catch (error) {
    mcpMessage.textContent = error.message || "Could not disconnect";
  } finally {
    mcpDisconnect.disabled = false;
  }
});

function note(text) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

function clock(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Madrid",
  }).format(new Date(iso));
}

poll();
setInterval(poll, 1500);
