const GROUPS = [
  {
    id: "weather",
    title: "Weather",
    blurb: "Live Open-Meteo forecast for Castellón de la Plana.",
  },
  {
    id: "orders",
    title: "Orders",
    blurb: "Fictional salon tickets. Logged when the agent looks one up.",
  },
  {
    id: "crm",
    title: "CRM",
    blurb: "Fictional client book and upcoming appointments.",
  },
  {
    id: "database",
    title: "Database",
    blurb: "Fictional services, staff, and opening hours.",
  },
];

let latest = null;
let signature = "";

const statusPill = document.querySelector("#statusPill");
const statStatus = document.querySelector("#statStatus");
const engine = document.querySelector("#engine");
const statActive = document.querySelector("#statActive");
const statActiveHint = document.querySelector("#statActiveHint");
const statToday = document.querySelector("#statToday");
const statDenies = document.querySelector("#statDenies");
const statTools = document.querySelector("#statTools");
const conv = document.querySelector("#conv");
const convMeta = document.querySelector("#convMeta");
const security = document.querySelector("#security");
const toolGrid = document.querySelector("#toolGrid");
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
  statusPill.classList.toggle("offline", !online);
  statusPill.lastChild.textContent = online ? " Online" : " Offline";
  if (!online) statStatus.textContent = "Offline";
}

function render(data) {
  statStatus.textContent = data.status === "online" ? "Online" : "Offline";
  engine.textContent = data.openai
    ? `OpenAI · ${data.model} · ${data.voice || "marin"}`
    : "Keyword planner";
  engine.title = data.openai
    ? `Chat ${data.model}. Realtime ${data.realtimeModel}. Voice ${data.voice}.`
    : "";
  statActive.textContent = String(data.activeCalls);
  statToday.textContent = String(data.callsToday);
  statDenies.textContent = String(data.denies);
  statTools.textContent = `${data.toolCallCount} tool calls`;
  const active = (data.recentCalls || []).filter((call) => call.status === "active");
  statActiveHint.textContent = active.length ? active.map((call) => call.id).join(", ") : "None live";
  renderConversation(data.conversation);
  renderSecurity(data.securityEvents || []);
  renderTools(data);
}

function renderConversation(conversation) {
  conv.replaceChildren();
  if (!conversation) {
    convMeta.textContent = "No calls yet";
    conv.append(note("Start a call on the voice desk."));
    return;
  }
  const badge = conversation.status === "active" ? "Live" : conversation.source === "seed" ? "Sample" : "Last call";
  convMeta.textContent = `${badge} · ${conversation.id}`;
  if (!conversation.messages.length) {
    conv.append(note("Call open. Waiting for the first thing said."));
    return;
  }
  for (const message of conversation.messages) {
    const item = document.createElement("li");
    item.className = `bubble ${message.role === "user" ? "user" : "assistant"}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = message.role === "user" ? "Caller" : "Sol";
    const body = document.createElement("p");
    body.textContent = message.text;
    item.append(who, body);
    if (message.tools?.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const tool of message.tools) {
        const el = document.createElement("span");
        el.className = `tag ${tool.decision === "deny" || tool.ok === false ? "bad" : "ok"}`;
        el.textContent = tool.name;
        tags.append(el);
      }
      item.append(tags);
    }
    conv.append(item);
  }
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

function renderTools(data) {
  toolGrid.replaceChildren();
  const now = Date.now();
  for (const group of GROUPS) {
    const card = document.createElement("article");
    card.className = "tool-card";
    const logs = (data.toolCalls || []).filter((call) => call.group === group.id);
    if (logs[0] && now - new Date(logs[0].at).getTime() < 8000) card.classList.add("fresh");
    const title = document.createElement("h3");
    title.textContent = group.title;
    const blurb = document.createElement("p");
    blurb.className = "desc";
    blurb.textContent = group.blurb;
    const names = document.createElement("div");
    names.className = "names";
    for (const tool of (data.tools || []).filter((tool) => tool.group === group.id)) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = tool.name;
      names.append(chip);
    }
    card.append(title, blurb, names);
    for (const record of recordsFor(group.id, data.catalog)) card.append(record);
    const logTitle = document.createElement("p");
    logTitle.className = "desc";
    logTitle.textContent = logs.length ? "Recent calls" : "No calls yet";
    card.append(logTitle);
    for (const log of logs.slice(0, 3)) card.append(logItem(log));
    toolGrid.append(card);
  }
}

function recordsFor(group, catalog) {
  if (!catalog) return [];
  if (group === "orders") return catalog.orders.map((order) => line(`${order.id} · ${order.customer}`, `${order.status} · ${order.service} · €${order.totalEur}`));
  if (group === "crm") {
    return catalog.customers.map((customer) => {
      const next = customer.nextAppointment
        ? `${customer.nextAppointment.date} ${customer.nextAppointment.time}`
        : "no upcoming visit";
      return line(customer.name, `${customer.loyalty} · ${next}`);
    });
  }
  if (group === "database") {
    const hours = catalog.hours.days
      .filter((day) => day.open)
      .map((day) => day.day.slice(0, 3))
      .join(" ");
    return [
      line("Hours", `Tue–Sat 10:00–20:00 · ${hours}`),
      ...catalog.services.slice(0, 3).map((service) => line(service.name, `€${service.priceEur} · ${service.minutes} min`)),
      ...catalog.staff.map((person) => line(person.name, person.role)),
    ];
  }
  return [line("Source", "api.open-meteo.com · no API key")];
}

function line(title, detail) {
  const row = document.createElement("div");
  row.className = "record";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("div");
  span.textContent = detail;
  row.append(strong, span);
  return row;
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
