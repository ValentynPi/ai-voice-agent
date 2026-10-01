import { emptyState, formatWhen, readJson } from "./ui.js";

const list = document.querySelector("#numberList");
const errorEl = document.querySelector("#error");
const lede = document.querySelector("#lede");
const consoleLink = document.querySelector("#consoleLink");
const buyLink = document.querySelector("#buyLink");

let agentsById = new Map();
let lastPayload = null;

function formatPhone(value) {
  const raw = String(value || "");
  if (raw.startsWith("+34") && raw.length === 12) {
    return `+34 ${raw.slice(3, 6)} ${raw.slice(6, 9)} ${raw.slice(9)}`;
  }
  if (raw.startsWith("+972") && raw.length >= 12) {
    return `+972 ${raw.slice(4, 5)} ${raw.slice(5, 8)} ${raw.slice(8)}`;
  }
  return raw;
}

function agentLabel(agentId) {
  if (!agentId) return "Unassigned";
  const agent = agentsById.get(agentId);
  return agent ? agent.name : agentId;
}

async function assignNumber(sid, agentId) {
  return readJson(await fetch("/api/phone-numbers/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid, agentId: agentId || "" }),
  }));
}

function render(payload) {
  lastPayload = payload;
  const numbers = payload.incoming_phone_numbers || [];
  if (payload.console_url) consoleLink.href = payload.console_url;
  if (payload.buy_url) buyLink.href = payload.buy_url;

  const source =
    payload.source === "telephony"
      ? "Synced from the telephony host."
      : "Listed from this server’s local store.";
  const mode = payload.mode === "connected" ? "Connected Twilio account." : "Demo mode (not bought on Twilio).";
  lede.textContent = `${source} ${mode} Connect an agent so Voice URL includes ?agentId=. Buy numbers on the telephony console.`;

  list.replaceChildren();
  if (!numbers.length) {
    list.append(
      emptyState(
        "No phone numbers yet",
        "Open the telephony console, buy a demo number, then refresh this page.",
      ),
    );
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Number", "Friendly name", "Agent", "Voice URL", "Added", ""]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const number of numbers) body.append(row(number));
  table.append(head, body);
  wrap.append(table);
  list.append(wrap);
}

function row(number) {
  const tr = document.createElement("tr");
  const phone = document.createElement("td");
  const strong = document.createElement("strong");
  strong.textContent = formatPhone(number.phone_number);
  phone.append(strong);
  if (number.demo) {
    const sub = document.createElement("div");
    sub.className = "quiet";
    sub.textContent = "Demo · not purchased on Twilio";
    phone.append(sub);
  }
  const name = document.createElement("td");
  name.textContent = number.friendly_name || "—";

  const agentCell = document.createElement("td");
  if (number.agent_id) {
    const link = document.createElement("a");
    link.href = `/agents/${encodeURIComponent(number.agent_id)}`;
    link.textContent = agentLabel(number.agent_id);
    agentCell.append(link);
  } else {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = "Unassigned";
    agentCell.append(pill);
  }

  const voice = document.createElement("td");
  voice.className = "quiet";
  voice.style.wordBreak = "break-all";
  voice.style.maxWidth = "280px";
  voice.textContent = number.voice_url || "—";
  const when = document.createElement("td");
  when.className = "quiet";
  when.textContent = formatWhen(number.date_created) || "—";

  const actions = document.createElement("td");
  const group = document.createElement("div");
  group.className = "row-actions";
  const select = document.createElement("select");
  select.className = "btn small ghost";
  select.style.maxWidth = "160px";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Unassigned";
  select.append(blank);
  for (const agent of agentsById.values()) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.name;
    if (agent.id === number.agent_id) option.selected = true;
    select.append(option);
  }
  if (number.agent_id && !agentsById.has(number.agent_id)) {
    const option = document.createElement("option");
    option.value = number.agent_id;
    option.textContent = number.agent_id;
    option.selected = true;
    select.append(option);
  }
  const apply = document.createElement("button");
  apply.className = "btn small primary";
  apply.type = "button";
  apply.textContent = "Apply";
  apply.addEventListener("click", async () => {
    errorEl.hidden = true;
    apply.disabled = true;
    try {
      await assignNumber(number.sid, select.value);
      await load();
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error.message || "Could not update binding.";
    } finally {
      apply.disabled = false;
    }
  });
  group.append(select, apply);
  actions.append(group);

  tr.append(phone, name, agentCell, voice, when, actions);
  return tr;
}

async function load() {
  errorEl.hidden = true;
  try {
    const [payload, agentsBody] = await Promise.all([
      readJson(await fetch("/api/phone-numbers")),
      readJson(await fetch("/api/agents")).catch(() => ({ agents: [] })),
    ]);
    agentsById = new Map((agentsBody.agents || []).map((a) => [a.id, a]));
    render(payload);
  } catch (error) {
    list.replaceChildren();
    errorEl.hidden = false;
    errorEl.textContent = error.message || "Could not load phone numbers.";
    list.append(
      emptyState("Could not load numbers", "Check that the telephony host is up, then refresh."),
    );
  }
}

load();
