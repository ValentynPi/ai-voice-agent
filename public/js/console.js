const view = document.querySelector("#view");
const errorBox = document.querySelector("#error");
const banner = document.querySelector("#banner");
const badge = document.querySelector("#modeBadge");
const accountChip = document.querySelector("#accountChip");
const drawer = document.querySelector("#drawer");
const backdrop = document.querySelector("#backdrop");

let account = null;

const PHONE_COUNTRIES = [
  { iso: "ES", name: "Spain", dial: "+34" },
  { iso: "IL", name: "Israel", dial: "+972" },
  { iso: "US", name: "United States", dial: "+1" },
  { iso: "GB", name: "United Kingdom", dial: "+44" },
];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || "Request failed");
  return body;
}

function showError(error) {
  errorBox.hidden = false;
  errorBox.textContent = error.message || "Something went wrong";
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Europe/Madrid",
  }).format(date);
}

function formatPhone(value) {
  const raw = String(value || "");
  if (!raw) return "—";
  if (raw.startsWith("client:")) return raw;
  if (raw.startsWith("+34") && raw.length === 12) {
    return `+34 ${raw.slice(3, 6)} ${raw.slice(6, 9)} ${raw.slice(9)}`;
  }
  if (raw.startsWith("+972") && raw.length === 12) {
    return `+972 ${raw.slice(4, 5)} ${raw.slice(5, 8)} ${raw.slice(8)}`;
  }
  if (raw.startsWith("+972") && raw.length === 13) {
    return `+972 ${raw.slice(4, 6)} ${raw.slice(6, 9)} ${raw.slice(9)}`;
  }
  return raw;
}

function formatDuration(value) {
  if (value == null || value === "") return "—";
  const total = Number(value);
  if (!Number.isFinite(total)) return "—";
  const minutes = Math.floor(total / 60);
  const seconds = Math.abs(total % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function statusLabel(status) {
  const labels = {
    queued: "Queued",
    ringing: "Ringing",
    "in-progress": "In progress",
    completed: "Completed",
    failed: "Failed",
    busy: "Busy",
    "no-answer": "No answer",
    canceled: "Canceled",
    "in-use": "In use",
  };
  return labels[status] || status || "—";
}

function pillClass(status) {
  if (status === "completed" || status === "in-use") return "ok";
  if (status === "in-progress" || status === "ringing") return "live";
  if (status === "failed" || status === "busy") return "bad";
  if (status === "no-answer") return "warn";
  return "";
}

function directionLabel(value) {
  if (value === "inbound") return "Inbound";
  if (String(value || "").startsWith("outbound")) return "Outbound";
  return value || "—";
}

function caps(value) {
  if (!value) return "—";
  const list = [];
  if (value.voice || value.Voice) list.push("Voice");
  if (value.sms || value.SMS) list.push("SMS");
  if (value.mms || value.MMS) list.push("MMS");
  return list.join(", ") || "—";
}

function absoluteUrl(value) {
  if (!value) return "";
  if (String(value).startsWith("/")) return `${location.origin}${value}`;
  return String(value);
}

function head(kicker, title, lede, actions = "") {
  return `<header class="cx-head"><div><p class="cx-kicker">${esc(kicker)}</p><h1>${esc(title)}</h1>${lede ? `<p class="cx-lede">${lede}</p>` : ""}</div><div class="cx-actions">${actions}</div></header>`;
}

function paintChrome() {
  const connected = account?.mode === "connected";
  badge.className = `cx-badge ${connected ? "connected" : "demo"}`;
  badge.textContent = connected ? "Connected" : "Demo";
  accountChip.textContent = account?.account_sid || "Account";
  banner.className = `cx-banner${connected ? " connected" : ""}`;
  banner.textContent = connected
    ? "Connected. Phone number and call lists come from the Twilio API. Browser test calls are still added locally so the log stays continuous."
    : "Demo mode. This console stores numbers locally. Nothing here is bought on Twilio until the account is connected.";
  document.title = connected ? "Telephony console · Connected" : "Telephony console · Demo";
}

function highlightNav() {
  const path = location.pathname.replace(/\/$/, "") || "/console";
  const match = path === "/console" ? "home"
    : path.includes("/search") ? "buy"
    : path.includes("/phone-numbers") ? "numbers"
    : path.includes("/calls") ? "calls"
    : path.includes("/twiml") ? "apps"
    : path.includes("/logs") ? "logs"
    : path.includes("/keys") ? "keys"
    : "";
  for (const link of document.querySelectorAll("#sideNav a")) {
    if (link.dataset.match === match) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function closeDrawer() {
  drawer.hidden = true;
  backdrop.hidden = true;
  drawer.innerHTML = "";
}

function openDrawer(title, sid, body, bind) {
  drawer.hidden = false;
  backdrop.hidden = false;
  drawer.innerHTML = `<header><div><h2>${esc(title)}</h2>${sid ? `<p class="sid mono">${esc(sid)}</p>` : ""}</div><button class="cx-btn ghost" type="button" data-close>Close</button></header>${body}`;
  drawer.querySelector("[data-close]").addEventListener("click", closeDrawer);
  if (bind) bind(drawer);
  drawer.querySelector("button, input, select, a")?.focus();
}

function resourcePath(suffix) {
  return `/api/twilio/v1/Accounts/${account.account_sid}${suffix}`;
}

function emptyRow(cols, text) {
  return `<tr><td class="cx-empty" colspan="${cols}">${esc(text)}</td></tr>`;
}

async function overview() {
  const [numbers, calls, events] = await Promise.all([
    api(resourcePath("/IncomingPhoneNumbers")),
    api(resourcePath("/Calls")),
    api(resourcePath("/Monitor/Events")),
  ]);
  const recent = (calls.calls || []).slice(0, 5);
  view.innerHTML = `
    ${head("Telephony", "Overview", "Phone numbers, voice calls, webhooks, and API keys. The agent builder stays on Agents.")}
    <section class="cx-stats">
      <article class="cx-stat"><span>Active numbers</span><strong>${numbers.incoming_phone_numbers.length}</strong></article>
      <article class="cx-stat"><span>Calls</span><strong>${calls.calls.length}</strong></article>
      <article class="cx-stat"><span>Webhook logs</span><strong>${events.events.length}</strong></article>
    </section>
    <section class="cx-card">
      <h2>Voice webhooks for this app</h2>
      <p>Paste these into a TwiML App or a phone number. Method is HTTP POST. The voice URL returns TwiML.</p>
      <div class="cx-url-row"><span>Voice URL</span><code>${esc(account.voice_webhook_url)}</code><button class="cx-btn ghost" type="button" data-copy="${esc(account.voice_webhook_url)}">Copy</button></div>
      <div class="cx-url-row"><span>Status callback</span><code>${esc(account.status_callback_url)}</code><button class="cx-btn ghost" type="button" data-copy="${esc(account.status_callback_url)}">Copy</button></div>
    </section>
    <section class="cx-card">
      <h2>Recent calls</h2>
      <p>Browser test calls show up here as <span class="mono">client:browser</span>. PSTN audio still needs Media Streams.</p>
    </section>
    ${callsTable(recent, "No calls yet. A web test call from Agents will land here.")}
  `;
  bindCopies(view);
  bindCallRows(view);
}

function callsTable(calls, empty) {
  const rows = calls.length ? calls.map((call) => `
    <tr class="clickable" data-call="${esc(call.sid)}" tabindex="0">
      <td><span class="primary mono">${esc(call.sid)}</span>${call.demo ? `<span class="sub">${esc(call.media === "browser-realtime" ? "Browser client" : "Demo")}</span>` : ""}</td>
      <td>${esc(formatPhone(call.from))}</td>
      <td>${esc(formatPhone(call.to))}</td>
      <td>${esc(directionLabel(call.direction))}</td>
      <td><span class="cx-pill ${pillClass(call.status)}">${esc(statusLabel(call.status))}</span></td>
      <td>${esc(formatDuration(call.duration))}</td>
      <td>${esc(formatWhen(call.start_time))}</td>
    </tr>
  `).join("") : emptyRow(7, empty);
  return `<div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Call SID</th><th>From</th><th>To</th><th>Direction</th><th>Status</th><th>Duration</th><th>Start</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function bindCallRows(root) {
  for (const row of root.querySelectorAll("[data-call]")) {
    const open = () => openCall(row.dataset.call);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  }
}

async function numbersPage() {
  const data = await api(resourcePath("/IncomingPhoneNumbers"));
  const rows = data.incoming_phone_numbers.length ? data.incoming_phone_numbers.map((number) => `
    <tr class="clickable" data-number="${esc(number.sid)}" tabindex="0">
      <td><span class="primary">${esc(formatPhone(number.phone_number))}</span>${number.demo ? `<span class="sub cx-flag">Demo · not purchased on Twilio</span>` : `<span class="sub">Twilio</span>`}</td>
      <td>${esc(number.friendly_name)}</td>
      <td class="mono">${esc(number.voice_url || "—")}</td>
      <td>${esc(caps(number.capabilities))}</td>
      <td><span class="cx-pill ${pillClass(number.status)}">${esc(statusLabel(number.status))}</span></td>
    </tr>
  `).join("") : emptyRow(5, "No numbers on this account.");
  view.innerHTML = `
    ${head("Phone Numbers", "Active numbers", account.demo ? "These rows live in SQLite. Buying one here does not create it on Twilio." : "These rows come from the connected Twilio account.", `<a class="cx-btn primary" href="/console/phone-numbers/search" data-cx>Buy a number</a>`)}
    <div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Number</th><th>Friendly name</th><th>Voice URL</th><th>Capabilities</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  for (const row of view.querySelectorAll("[data-number]")) {
    const open = () => openNumber(row.dataset.number);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  }
}

async function openNumber(sid) {
  const number = await api(resourcePath(`/IncomingPhoneNumbers/${sid}`));
  openDrawer(formatPhone(number.phone_number), number.sid, `
    ${number.demo ? `<p class="cx-note">Demo number. It is stored on this server and was not purchased on Twilio.</p>` : `<p class="cx-note">This number is on the connected Twilio account. Saving updates it there.</p>`}
    <dl class="cx-dl">
      <dt>Friendly name</dt><dd>${esc(number.friendly_name)}</dd>
      <dt>Capabilities</dt><dd>${esc(caps(number.capabilities))}</dd>
      <dt>Status</dt><dd>${esc(statusLabel(number.status))}</dd>
      <dt>Voice method</dt><dd>${esc(number.voice_method)}</dd>
      <dt>Created</dt><dd>${esc(formatWhen(number.date_created))}</dd>
    </dl>
    <form class="cx-form" id="numberForm">
      <label>Friendly name<input name="friendly_name" value="${esc(number.friendly_name)}" required></label>
      <label>Voice URL<input name="voice_url" value="${esc(absoluteUrl(number.voice_url))}" placeholder="${esc(account.voice_webhook_url)}"></label>
      <label>Voice method<select name="voice_method"><option ${number.voice_method === "GET" ? "" : "selected"}>POST</option><option ${number.voice_method === "GET" ? "selected" : ""}>GET</option></select></label>
      <label>Status callback URL<input name="status_callback" value="${esc(absoluteUrl(number.status_callback))}" placeholder="${esc(account.status_callback_url)}"></label>
      <label>Status callback method<select name="status_callback_method"><option ${number.status_callback_method === "GET" ? "" : "selected"}>POST</option><option ${number.status_callback_method === "GET" ? "selected" : ""}>GET</option></select></label>
      <button class="cx-btn primary" type="submit">Save number</button>
    </form>
  `, (root) => {
    root.querySelector("#numberForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await api(resourcePath(`/IncomingPhoneNumbers/${sid}`), {
          method: "POST",
          body: JSON.stringify({
            friendly_name: form.get("friendly_name"),
            voice_url: form.get("voice_url"),
            voice_method: form.get("voice_method"),
            status_callback: form.get("status_callback"),
            status_callback_method: form.get("status_callback_method"),
          }),
        });
        closeDrawer();
        await numbersPage();
      } catch (error) {
        showError(error);
      }
    });
  });
}

async function buyPage() {
  const params = new URLSearchParams(location.search);
  const country = params.get("country") || "ES";
  const contains = params.get("contains") || "";
  const sms = params.get("sms") === "1";
  let result = { available_phone_numbers: [], message: "" };
  if (location.search || country) {
    const query = new URLSearchParams();
    if (contains) query.set("Contains", contains);
    if (sms) query.set("SmsEnabled", "true");
    result = await api(`${resourcePath(`/AvailablePhoneNumbers/${country}/Local`)}?${query}`);
  }
  const rows = result.available_phone_numbers.length ? result.available_phone_numbers.map((number) => `
    <tr>
      <td><span class="primary">${esc(formatPhone(number.phone_number))}</span>${number.demo ? `<span class="sub cx-flag">Simulated inventory</span>` : ""}</td>
      <td>${esc([number.locality, number.region].filter(Boolean).join(", ") || "—")}</td>
      <td>${esc(caps(number.capabilities))}</td>
      <td><button class="cx-btn primary" type="button" data-buy="${esc(number.phone_number)}">${account.demo ? "Add demo number" : "Buy"}</button></td>
    </tr>
  `).join("") : emptyRow(4, result.message || "Search to see numbers.");
  view.innerHTML = `
    ${head("Phone Numbers", "Buy a number", account.demo ? "Demo search only. Adding a number writes it locally and does not buy it from Twilio." : "Search uses the Twilio available-numbers API. Buying creates a real number and can cost money.")}
    <form class="cx-filters" id="searchForm">
      <label>Country<select name="country">${PHONE_COUNTRIES.map((item) => `<option value="${item.iso}" ${country === item.iso ? "selected" : ""}>${esc(item.name)} (${esc(item.dial)})</option>`).join("")}</select></label>
      <label>Contains<input name="contains" value="${esc(contains)}" placeholder="${country === "IL" ? "351" : "964"}" inputmode="numeric"></label>
      <label class="cx-check"><input type="checkbox" name="sms" ${sms ? "checked" : ""}> SMS</label>
      <button class="cx-btn" type="submit">Search</button>
    </form>
    ${result.message ? `<p class="cx-lede" style="margin-bottom:12px">${esc(result.message)}</p>` : ""}
    <div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Number</th><th>Locality</th><th>Capabilities</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  view.querySelector("#searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    next.set("country", form.get("country"));
    if (form.get("contains")) next.set("contains", form.get("contains"));
    if (form.get("sms")) next.set("sms", "1");
    navigate(`/console/phone-numbers/search?${next}`);
  });
  for (const button of view.querySelectorAll("[data-buy]")) {
    button.addEventListener("click", () => openBuy(button.dataset.buy));
  }
}

function openBuy(phone) {
  const demo = account.demo;
  openDrawer(formatPhone(phone), demo ? "Demo purchase" : "Twilio purchase", `
    <p class="${demo ? "cx-note" : "cx-note danger"}">${demo
      ? "This adds a local IncomingPhoneNumber. Twilio is not called and the number is not purchased on a carrier."
      : "This creates an IncomingPhoneNumber on the connected Twilio account and can cost money."}</p>
    <form class="cx-form" id="buyForm">
      <label>Friendly name<input name="friendly_name" value="${esc(formatPhone(phone))}" required></label>
      ${demo ? "" : `<label class="cx-check"><input type="checkbox" name="confirm_purchase" required> I understand this purchases a number on Twilio</label>`}
      <button class="cx-btn primary" type="submit">${demo ? "Add demo number" : "Buy on Twilio"}</button>
    </form>
  `, (root) => {
    root.querySelector("#buyForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const created = await api(resourcePath("/IncomingPhoneNumbers"), {
          method: "POST",
          body: JSON.stringify({
            phone_number: phone,
            friendly_name: form.get("friendly_name"),
            voice_url: account.voice_webhook_url,
            status_callback: account.status_callback_url,
            confirm_purchase: form.get("confirm_purchase") === "on",
          }),
        });
        closeDrawer();
        history.pushState({}, "", "/console/phone-numbers");
        await render();
        await openNumber(created.sid);
      } catch (error) {
        showError(error);
      }
    });
  });
}

async function callsPage() {
  const params = new URLSearchParams(location.search);
  const query = new URLSearchParams();
  if (params.get("status")) query.set("Status", params.get("status"));
  if (params.get("direction")) query.set("Direction", params.get("direction"));
  if (params.get("from")) query.set("From", params.get("from"));
  const data = await api(`${resourcePath("/Calls")}?${query}`);
  const statuses = ["", "queued", "ringing", "in-progress", "completed", "failed", "busy", "no-answer"];
  view.innerHTML = `
    ${head("Voice", "Calls", "Call SID, direction, and status follow Twilio's call resource. A browser test call is an inbound client:browser leg.")}
    <form class="cx-filters" id="callFilters">
      <label>Status<select name="status">${statuses.map((status) => `<option value="${esc(status)}" ${params.get("status") === status ? "selected" : ""}>${esc(status ? statusLabel(status) : "Any")}</option>`).join("")}</select></label>
      <label>Direction<select name="direction"><option value="">Any</option><option value="inbound" ${params.get("direction") === "inbound" ? "selected" : ""}>Inbound</option><option value="outbound" ${params.get("direction") === "outbound" ? "selected" : ""}>Outbound</option></select></label>
      <label>From<input name="from" value="${esc(params.get("from") || "")}" placeholder="client:browser"></label>
      <button class="cx-btn" type="submit">Filter</button>
    </form>
    ${callsTable(data.calls || [], "No calls match.")}
  `;
  view.querySelector("#callFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (form.get("status")) next.set("status", form.get("status"));
    if (form.get("direction")) next.set("direction", form.get("direction"));
    if (form.get("from")) next.set("from", form.get("from"));
    const search = next.toString();
    navigate(`/console/voice/calls${search ? `?${search}` : ""}`);
  });
  bindCallRows(view);
}

async function openCall(sid) {
  const call = await api(resourcePath(`/Calls/${sid}`));
  const recordings = await api(resourcePath(`/Calls/${sid}/Recordings`));
  const recording = recordings.recordings?.[0];
  openDrawer(directionLabel(call.direction), call.sid, `
    ${call.media === "browser-realtime" ? `<p class="cx-note">Browser client. The audio was OpenAI Realtime in the test call, not a PSTN recording.</p>` : ""}
    ${call.demo && call.media !== "browser-realtime" ? `<p class="cx-note">Demo call stored locally. It was not placed on the Twilio network.</p>` : ""}
    <dl class="cx-dl">
      <dt>From</dt><dd>${esc(formatPhone(call.from))}</dd>
      <dt>To</dt><dd>${esc(formatPhone(call.to))}</dd>
      <dt>Direction</dt><dd>${esc(directionLabel(call.direction))}</dd>
      <dt>Status</dt><dd>${esc(statusLabel(call.status))}</dd>
      <dt>Duration</dt><dd>${esc(formatDuration(call.duration))}</dd>
      <dt>Start</dt><dd>${esc(formatWhen(call.start_time))}</dd>
      <dt>End</dt><dd>${esc(formatWhen(call.end_time))}</dd>
      <dt>Recording URL</dt><dd class="mono">${recording ? esc(recording.uri || call.recording_url || "—") : esc(call.recording_url || "—")}</dd>
      <dt>Media</dt><dd>${esc(call.media || (call.demo ? "demo" : "twilio"))}</dd>
    </dl>
    ${recording?.note ? `<p class="cx-lede">${esc(recording.note)}</p>` : ""}
    ${call.annotation ? `<p class="cx-lede">${esc(call.annotation)}</p>` : ""}
    ${call.local_call_id ? `<p><a href="/history/${esc(call.local_call_id)}">Open the agent transcript</a></p>` : ""}
  `);
}

async function appsPage() {
  const data = await api(resourcePath("/Applications"));
  const rows = data.applications.length ? data.applications.map((app) => `
    <tr class="clickable" data-app="${esc(app.sid)}" tabindex="0">
      <td><span class="primary">${esc(app.friendly_name)}</span>${app.demo ? `<span class="sub cx-flag">Demo app</span>` : ""}</td>
      <td class="mono">${esc(app.sid)}</td>
      <td class="mono">${esc(app.voice_url || "—")}</td>
      <td class="mono">${esc(app.status_callback || "—")}</td>
    </tr>
  `).join("") : emptyRow(4, "No TwiML Apps yet.");
  view.innerHTML = `
    ${head("Develop", "TwiML Apps", "Point voice and status callbacks at this app. Saving a demo app updates SQLite. A connected account updates Twilio.", `<button class="cx-btn primary" type="button" id="newApp">Create TwiML App</button>`)}
    <section class="cx-card">
      <h2>Endpoints to paste into Twilio</h2>
      <p>Use POST. The voice webhook responds with a Say verb until Media Streams is connected.</p>
      <div class="cx-url-row"><span>Voice URL</span><code>${esc(account.voice_webhook_url)}</code><button class="cx-btn ghost" type="button" data-copy="${esc(account.voice_webhook_url)}">Copy</button></div>
      <div class="cx-url-row"><span>Status callback</span><code>${esc(account.status_callback_url)}</code><button class="cx-btn ghost" type="button" data-copy="${esc(account.status_callback_url)}">Copy</button></div>
    </section>
    <div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Friendly name</th><th>SID</th><th>Voice URL</th><th>Status callback</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  bindCopies(view);
  view.querySelector("#newApp").addEventListener("click", () => openAppForm(null));
  for (const row of view.querySelectorAll("[data-app]")) {
    const open = () => openApp(row.dataset.app);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  }
}

async function openApp(sid) {
  const app = await api(resourcePath(`/Applications/${sid}`));
  openAppForm(app);
}

function openAppForm(app) {
  const creating = !app;
  openDrawer(creating ? "New TwiML App" : app.friendly_name, creating ? "" : app.sid, `
    ${creating || app.demo ? `<p class="cx-note">Demo mode stores this app locally. Connect Twilio before these URLs are configured on a live account from this save.</p>` : `<p class="cx-note">Saving updates the TwiML App on the connected Twilio account.</p>`}
    <form class="cx-form" id="appForm">
      <label>Friendly name<input name="friendly_name" value="${esc(app?.friendly_name || "Maison Sol Voice")}" required></label>
      <label>Voice URL<input name="voice_url" value="${esc(absoluteUrl(app?.voice_url || account.voice_webhook_url))}" required></label>
      <label>Voice method<select name="voice_method"><option ${app?.voice_method === "GET" ? "" : "selected"}>POST</option><option ${app?.voice_method === "GET" ? "selected" : ""}>GET</option></select></label>
      <label>Status callback URL<input name="status_callback" value="${esc(absoluteUrl(app?.status_callback || account.status_callback_url))}"></label>
      <label>Status callback method<select name="status_callback_method"><option ${app?.status_callback_method === "GET" ? "" : "selected"}>POST</option><option ${app?.status_callback_method === "GET" ? "selected" : ""}>GET</option></select></label>
      <button class="cx-btn primary" type="submit">${creating ? "Create" : "Save"}</button>
    </form>
  `, (root) => {
    root.querySelector("#appForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = {
        friendly_name: form.get("friendly_name"),
        voice_url: form.get("voice_url"),
        voice_method: form.get("voice_method"),
        status_callback: form.get("status_callback"),
        status_callback_method: form.get("status_callback_method"),
      };
      try {
        if (creating) await api(resourcePath("/Applications"), { method: "POST", body: JSON.stringify(payload) });
        else await api(resourcePath(`/Applications/${app.sid}`), { method: "POST", body: JSON.stringify(payload) });
        closeDrawer();
        await appsPage();
      } catch (error) {
        showError(error);
      }
    });
  });
}

async function logsPage() {
  const data = await api(resourcePath("/Monitor/Events"));
  const rows = data.events.length ? data.events.map((event) => `
    <tr class="clickable" data-event="${esc(event.sid)}" tabindex="0">
      <td>${esc(formatWhen(event.date_created))}</td>
      <td><span class="cx-pill ${event.log_level === "warning" || event.log_level === "error" ? "warn" : "ok"}">${esc(event.log_level)}</span></td>
      <td>${esc(event.request_method)}</td>
      <td class="mono">${esc(event.request_url)}</td>
      <td class="mono">${esc(event.call_sid || "—")}</td>
      <td>${esc(event.response_status_code)}</td>
    </tr>
  `).join("") : emptyRow(6, "No webhook deliveries yet.");
  view.innerHTML = `
    ${head("Monitor", "Logs", "Debugger-style deliveries to this app's voice webhook and status callback. Request secrets are not stored.")}
    <div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Time</th><th>Level</th><th>Method</th><th>URL</th><th>Call SID</th><th>Response</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  for (const row of view.querySelectorAll("[data-event]")) {
    const open = () => openEvent(row.dataset.event);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  }
}

async function openEvent(sid) {
  const event = await api(resourcePath(`/Monitor/Events/${sid}`));
  const variables = Object.entries(event.request_variables || {}).map(([key, value]) => `${key}: ${value}`).join("\n") || "(no parameters)";
  openDrawer(event.message, event.sid, `
    <dl class="cx-dl">
      <dt>Level</dt><dd>${esc(event.log_level)}</dd>
      <dt>Signature</dt><dd>${esc(event.signature)}</dd>
      <dt>Response</dt><dd>${esc(event.response_status_code)}</dd>
      <dt>When</dt><dd>${esc(formatWhen(event.date_created))}</dd>
    </dl>
    <h2 style="font-size:14px">Request variables</h2>
    <pre class="cx-pre">${esc(variables)}</pre>
    <h2 style="font-size:14px;margin-top:14px">Response body</h2>
    <pre class="cx-pre">${esc(event.response_body || "(empty)")}</pre>
  `);
}

async function keysPage() {
  const tokenLabel = account.auth_token_set
    ? `Stored on the server (${account.auth_token_source}). It is not sent back to this page.`
    : "No auth token stored.";
  const secretLabel = account.api_key_secret_set ? "An API key secret is stored on the server." : "No API key secret stored.";
  view.innerHTML = `
    ${head("Account", "API keys & tokens", "Credentials stay on the server. Demo mode continues until TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set in the environment.")}
    <section class="cx-card">
      <h2>${account.demo ? "Demo account" : "Connected account"}</h2>
      <dl class="cx-dl">
        <dt>Account SID</dt><dd class="mono">${esc(account.account_sid)}</dd>
        <dt>Friendly name</dt><dd>${esc(account.friendly_name)}</dd>
        <dt>Auth token</dt><dd>${esc(tokenLabel)}</dd>
        <dt>API key SID</dt><dd class="mono">${esc(account.api_key_sid || "—")}</dd>
        <dt>API key secret</dt><dd>${esc(secretLabel)}</dd>
        <dt>Mode</dt><dd>${account.demo ? "Demo" : "Connected"}</dd>
      </dl>
      ${account.environment_warning ? `<p class="cx-note">${esc(account.environment_warning)}</p>` : ""}
      <p>Saved values do not switch this page to Connected. Set the environment variables and restart to list live Twilio numbers and calls. Leave a secret blank to keep the one already stored.</p>
    </section>
    <form class="cx-form" id="keyForm">
      <label>Account SID to store<input name="account_sid" value="${esc(account.saved_account_sid || "")}" autocomplete="off" spellcheck="false" placeholder="AC…"></label>
      <label>Auth token<input name="auth_token" type="password" autocomplete="new-password" placeholder="${account.auth_token_set ? "•••• stored — leave blank to keep" : "Not stored"}"></label>
      <label>API key SID<input name="api_key_sid" value="${esc(account.api_key_sid || "")}" autocomplete="off" spellcheck="false" placeholder="SK…"></label>
      <label>API key secret<input name="api_key_secret" type="password" autocomplete="new-password" placeholder="${account.api_key_secret_set ? "•••• stored — leave blank to keep" : "Not stored"}"></label>
      <div class="cx-actions">
        <button class="cx-btn primary" type="submit">Save on server</button>
        <button class="cx-btn ghost" type="button" id="clearKeys">Remove stored secrets</button>
      </div>
    </form>
    <p id="keyNote" class="cx-lede" style="margin-top:12px"></p>
  `;
  view.querySelector("#keyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {};
    if (form.get("account_sid")) payload.account_sid = form.get("account_sid");
    if (form.get("auth_token")) payload.auth_token = form.get("auth_token");
    if (form.get("api_key_sid")) payload.api_key_sid = form.get("api_key_sid");
    if (form.get("api_key_secret")) payload.api_key_secret = form.get("api_key_secret");
    try {
      account = await api("/api/twilio/v1/account/credentials", { method: "PUT", body: JSON.stringify(payload) });
      paintChrome();
      await keysPage();
      view.querySelector("#keyNote").textContent = "Saved on the server. Secrets are not shown again.";
    } catch (error) {
      showError(error);
    }
  });
  view.querySelector("#clearKeys").addEventListener("click", async () => {
    try {
      account = await api("/api/twilio/v1/account/credentials", { method: "DELETE" });
      paintChrome();
      await keysPage();
      view.querySelector("#keyNote").textContent = "Stored secrets removed. Environment variables, if set, are unchanged.";
    } catch (error) {
      showError(error);
    }
  });
}

function bindCopies(root) {
  for (const button of root.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const value = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(value);
        const previous = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = previous; }, 1200);
      } catch {
        button.textContent = "Copy failed";
      }
    });
  }
}

function navigate(href) {
  const url = new URL(href, location.origin);
  history.pushState({}, "", `${url.pathname}${url.search}`);
  closeDrawer();
  render();
}

async function render() {
  clearError();
  highlightNav();
  view.innerHTML = `<p class="cx-lede">Loading…</p>`;
  try {
    account = await api("/api/twilio/v1/account");
    paintChrome();
    const path = location.pathname.replace(/\/$/, "") || "/console";
    if (path === "/console") await overview();
    else if (path === "/console/phone-numbers") await numbersPage();
    else if (path === "/console/phone-numbers/search") await buyPage();
    else if (path === "/console/voice/calls") await callsPage();
    else if (path === "/console/develop/twiml-apps") await appsPage();
    else if (path === "/console/monitor/logs") await logsPage();
    else if (path === "/console/account/keys") await keysPage();
    else view.innerHTML = `${head("Telephony", "Not found", "")}<p class="cx-lede">That console page is not available. <a href="/console" data-cx>Back to overview</a></p>`;
  } catch (error) {
    view.innerHTML = "";
    showError(error);
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-cx]");
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

backdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});
window.addEventListener("popstate", () => {
  closeDrawer();
  render();
});

render();
