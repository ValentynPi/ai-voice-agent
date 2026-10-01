import { emptyState, formatWhen, readJson } from "./ui.js";

const list = document.querySelector("#numberList");
const errorEl = document.querySelector("#error");
const lede = document.querySelector("#lede");
const consoleLink = document.querySelector("#consoleLink");
const buyLink = document.querySelector("#buyLink");

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

function render(payload) {
  const numbers = payload.incoming_phone_numbers || [];
  if (payload.console_url) consoleLink.href = payload.console_url;
  if (payload.buy_url) buyLink.href = payload.buy_url;

  const source =
    payload.source === "telephony"
      ? "Synced from the telephony host."
      : "Listed from this server’s local store.";
  const mode = payload.mode === "connected" ? "Connected Twilio account." : "Demo mode (not bought on Twilio).";
  lede.textContent = `${source} ${mode} Buy and configure on the telephony console; refresh this page to update.`;

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
  for (const label of ["Number", "Friendly name", "Status", "Voice URL", "Added"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const number of numbers) {
    const row = document.createElement("tr");
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
    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "pill ok";
    pill.textContent = number.status || "in-use";
    status.append(pill);
    const voice = document.createElement("td");
    voice.className = "quiet";
    voice.textContent = number.voice_url || "—";
    const when = document.createElement("td");
    when.className = "quiet";
    when.textContent = formatWhen(number.date_created) || "—";
    row.append(phone, name, status, voice, when);
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  list.append(wrap);
}

async function load() {
  errorEl.hidden = true;
  try {
    const payload = await readJson(await fetch("/api/phone-numbers"));
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
