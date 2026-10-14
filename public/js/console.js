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

/** Console path prefix: "/console" when nested, "" when telephony owns the host. */
const CONSOLE_BASE = (() => {
  const raw = document.documentElement.dataset.consoleBase;
  if (raw != null) return String(raw).replace(/\/$/, "");
  const path = location.pathname;
  if (path === "/console" || path.startsWith("/console/")) return "/console";
  return "";
})();

function cxPath(suffix = "") {
  const part = String(suffix || "");
  if (!part || part === "/") return CONSOLE_BASE || "/";
  const normalized = part.startsWith("/") ? part : `/${part}`;
  return `${CONSOLE_BASE}${normalized}`;
}


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


/** Agents brain origin only — strips trailing slash and /twilio/{voice,status,media} (+ query). */
function normalizeAgentsBaseUrl(url) {
  let raw = String(url || "").trim();
  if (!raw) return "";
  const suffixes = ["/twilio/voice", "/twilio/status", "/twilio/media"];
  const stripSuffix = (pathname) => {
    let path = String(pathname || "").replace(/\/+$/, "") || "";
    for (const suffix of suffixes) {
      if (path === suffix || path.endsWith(suffix)) {
        path = path.slice(0, -suffix.length);
        break;
      }
    }
    return path.replace(/\/+$/, "");
  };
  try {
    const parsed = new URL(raw);
    const path = stripSuffix(parsed.pathname);
    return `${parsed.origin}${path}`;
  } catch {
    raw = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
    for (const suffix of suffixes) {
      if (raw.endsWith(suffix)) {
        raw = raw.slice(0, -suffix.length);
        break;
      }
    }
    return raw.replace(/\/+$/, "");
  }
}

function absoluteUrl(value) {
  if (!value) return "";
  const raw = String(value);
  if (raw.startsWith("/")) {
    const brain = normalizeAgentsBaseUrl(account?.agents_public_url || "");
    if (brain && (raw.startsWith("/twilio/voice") || raw.startsWith("/twilio/status"))) {
      return `${brain}${raw}`;
    }
    return `${location.origin}${raw}`;
  }
  return raw;
}

function parseAgentIdFromVoiceUrl(voiceUrl) {
  const raw = String(voiceUrl || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("/") ? new URL(raw, location.origin) : new URL(raw);
    return String(url.searchParams.get("agentId") || url.searchParams.get("agent") || "").trim();
  } catch {
    const match = raw.match(/[?&]agentId=([^&]+)/i) || raw.match(/[?&]agent=([^&]+)/i);
    if (!match) return "";
    try { return decodeURIComponent(match[1]).trim(); } catch { return String(match[1] || "").trim(); }
  }
}

/** Resolve pasted Voice URL / Agents test link / bare agent id into an interactive web-call target. */
function savedAgentsBrain() {
  return normalizeAgentsBaseUrl(
    localStorage.getItem("cx-agents-url") || account?.agents_public_url || ""
  );
}

function telephonyDialUrl(agentsBase, agentId) {
  if (!agentId) return "";
  const params = new URLSearchParams();
  params.set("agentId", agentId);
  const base = normalizeAgentsBaseUrl(agentsBase || "");
  if (base) params.set("agentsBase", base);
  return `${cxPath("/voice/dial")}?${params.toString()}`;
}

function parseInteractiveCallTarget(raw, fallbackBrain = "") {
  const input = String(raw || "").trim();
  if (!input) {
    return { error: "Paste a Voice URL, Agents test link, or agent id." };
  }

  const looksLikeUrl = /^https?:\/\//i.test(input) || input.startsWith("/") || /[/?#]/.test(input);
  if (!looksLikeUrl) {
    if (!/^[A-Za-z0-9_.:-]{2,128}$/.test(input)) {
      return { error: "That does not look like a Voice URL or agent id." };
    }
    const brain = normalizeAgentsBaseUrl(fallbackBrain) || savedAgentsBrain();
    if (!brain) {
      return { error: "Save an Agents brain URL on Overview, or paste a full Voice URL / test link." };
    }
    return { agentId: input, agentsBase: brain };
  }

  let url;
  try {
    url = input.startsWith("/") ? new URL(input, location.origin) : new URL(input);
  } catch {
    return { error: "Invalid URL. Paste a Voice URL (…/twilio/voice?agentId=…), Agents test link, or agent id." };
  }

  let agentId = String(url.searchParams.get("agentId") || url.searchParams.get("agent") || "").trim();
  const pathTest = url.pathname.match(/\/agents\/([^/]+)\/test\/?$/i);
  if (!agentId && pathTest) {
    try { agentId = decodeURIComponent(pathTest[1]).trim(); } catch { agentId = String(pathTest[1] || "").trim(); }
  }
  if (!agentId) {
    return { error: "Could not find agentId in that link. Use …/twilio/voice?agentId=… or …/agents/<id>/test." };
  }

  let agentsBase = "";
  if (/\/twilio\/(voice|status|media)\b/i.test(url.pathname)) {
    agentsBase = normalizeAgentsBaseUrl(url.toString());
  } else {
    agentsBase = url.origin;
  }
  if (!agentsBase) agentsBase = normalizeAgentsBaseUrl(fallbackBrain) || savedAgentsBrain();
  if (!agentsBase) {
    return { error: "Could not determine Agents host from that link. Save a brain URL on Overview." };
  }
  return { agentId, agentsBase };
}

function makeCallCardHtml({ compact = false } = {}) {
  const title = "Make a call";
  const lede = compact
    ? "Paste a Voice URL or agent link, then call from this telephony console (stays on this host)."
    : "Paste an Agents Voice URL (<span class=\"mono\">…/twilio/voice?agentId=…</span>), an Agents test link, or just an agent id when the brain URL is saved. The interactive call runs on this telephony host — you are not sent to the Agents desk. Demo call remains a separate server probe.";
  const placeholder = "https://…/twilio/voice?agentId=… or …/agents/<id>/test";
  return `
    <section class="cx-card" id="makeCallCard">
      <h2>${esc(title)}</h2>
      <p>${lede}</p>
      <form class="cx-form" id="makeCallForm" style="margin-top:12px">
        <label>Voice URL / agent link<input name="call_target" id="makeCallInput" value="" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off"></label>
        <div class="cx-actions">
          <button class="cx-btn primary" type="submit" id="makeCallBtn">Call</button>
          ${compact ? `<a class="cx-btn ghost" href="${cxPath("/voice/calls")}" data-cx>Open Calls</a>` : ""}
        </div>
      </form>
      <p id="makeCallNote" class="cx-lede" style="margin-top:10px">Opens the telephony dialer for this Voice URL (same host).</p>
    </section>
  `;
}

function bindMakeCallForm(root) {
  const form = root.querySelector("#makeCallForm");
  const note = root.querySelector("#makeCallNote");
  const input = root.querySelector("#makeCallInput");
  if (!form || !input) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearError();
    const brainField = root.querySelector("#brainForm input[name=\"agents_url\"]");
    const fallback = brainField?.value || savedAgentsBrain();
    const parsed = parseInteractiveCallTarget(input.value, fallback);
    if (parsed.error) {
      if (note) {
        note.textContent = parsed.error;
        note.classList.add("cx-call-error");
      }
      showError(new Error(parsed.error));
      return;
    }
    const target = telephonyDialUrl(parsed.agentsBase, parsed.agentId);
    if (!target) {
      const msg = "Could not build telephony dialer URL.";
      if (note) {
        note.textContent = msg;
        note.classList.add("cx-call-error");
      }
      showError(new Error(msg));
      return;
    }
    localStorage.setItem("cx-agent-id", parsed.agentId);
    if (parsed.agentsBase) localStorage.setItem("cx-agents-url", parsed.agentsBase);
    if (note) {
      note.classList.remove("cx-call-error");
      note.textContent = `Opening telephony dialer for agent ${parsed.agentId}…`;
    }
    location.assign(target);
  });
}

function brainVoiceUrl(agentId = "") {
  const brain = normalizeAgentsBaseUrl(account?.agents_public_url || "");
  let root = "";
  if (brain) {
    root = `${brain}/twilio/voice`;
  } else {
    const raw = String(account?.voice_webhook_url || "").trim();
    if (raw) {
      const asBase = normalizeAgentsBaseUrl(raw);
      root = asBase && /\/twilio\/(voice|status|media)\b/i.test(raw)
        ? `${asBase}/twilio/voice`
        : raw;
    } else {
      root = "/twilio/voice";
    }
  }
  if (!agentId) return root.startsWith("/") ? absoluteUrl(root) : root;
  try {
    const url = new URL(root.startsWith("/") ? absoluteUrl(root) : root);
    url.searchParams.set("agentId", agentId);
    return url.toString();
  } catch {
    return `${root}${root.includes("?") ? "&" : "?"}agentId=${encodeURIComponent(agentId)}`;
  }
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
  const path = location.pathname.replace(/\/$/, "") || (CONSOLE_BASE || "/");
  const match = path === (CONSOLE_BASE || "/") || path === "/" ? "home"
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
  const urlAgent = new URLSearchParams(location.search).get("agentId") || "";
  if (urlAgent) localStorage.setItem("cx-agent-id", urlAgent);
  const savedBrain = normalizeAgentsBaseUrl(localStorage.getItem("cx-agents-url") || account.agents_public_url || "");
  const savedAgent = urlAgent || localStorage.getItem("cx-agent-id") || "";
  view.innerHTML = `
    ${head("Telephony", "Overview", "Phone numbers, voice calls, webhooks, and API keys. The agent builder stays on Agents.")}
    <section class="cx-stats">
      <article class="cx-stat"><span>Active numbers</span><strong>${numbers.incoming_phone_numbers.length}</strong></article>
      <article class="cx-stat"><span>Calls</span><strong>${calls.calls.length}</strong></article>
      <article class="cx-stat"><span>Webhook logs</span><strong>${events.events.length}</strong></article>
    </section>
    <section class="cx-card" id="brainCard">
      <h2>Connect to Agents</h2>
      <p>Primary: copy an agent’s Voice URL from Agents (<span class="mono">…/twilio/voice?agentId=…</span>) and paste it into a number’s Voice URL field below. Status callback should hit Agents <span class="mono">/twilio/status</span> — not this telephony host.</p>
      <form class="cx-form" id="brainForm">
        <label>Agents brain URL<input name="agents_url" value="${esc(savedBrain)}" placeholder="https://ai-voice-agent-valmax.fly.dev" spellcheck="false"></label>
        <label>Agent<select name="agent_id" id="agentPick"><option value="">Default agent</option></select></label>
        <div class="cx-actions">
          <button class="cx-btn primary" type="submit">Save connection</button>
          <button class="cx-btn ghost" type="button" id="loadAgents">Load agents</button>
          <button class="cx-btn ghost" type="button" id="applyVoiceUrls">Optional: apply Voice URL to all numbers</button>
          <button class="cx-btn ghost" type="button" id="demoCall">Demo call to Agents</button>
        </div>
      </form>
      <p id="brainNote" class="cx-lede" style="margin-top:12px"></p>
      <div class="cx-url-row" style="margin-top:12px"><span>Voice URL</span><code id="brainVoiceUrl">${esc(brainVoiceUrl(savedAgent))}</code><button class="cx-btn ghost" type="button" data-copy="${esc(brainVoiceUrl(savedAgent))}">Copy</button></div>
      <div class="cx-url-row"><span>Status callback</span><code>${esc(account.status_callback_url)}</code><button class="cx-btn ghost" type="button" data-copy="${esc(account.status_callback_url)}">Copy</button></div>
    </section>
    ${makeCallCardHtml({ compact: true })}
    <section class="cx-card">
      <h2>Recent calls</h2>
      <p>Browser test calls show up here as <span class="mono">client:browser</span>. Demo calls from this console exercise Media Streams into Agents.</p>
    </section>
    ${callsTable(recent, "No calls yet. Run a demo call or a web test call from Agents.")}
  `;
  bindCopies(view);
  bindCallRows(view);
  bindBrainCard(view, savedAgent);
  bindMakeCallForm(view);
}

async function fetchAgentsList(brainBase) {
  const base = normalizeAgentsBaseUrl(brainBase || "");
  if (!base) return [];
  const response = await fetch(`${base}/api/agents`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Could not load agents from ${base} (${response.status})`);
  const body = await response.json();
  return Array.isArray(body.agents) ? body.agents : [];
}

function refreshBrainVoiceDisplay(root, agentId) {
  const url = brainVoiceUrl(agentId);
  const code = root.querySelector("#brainVoiceUrl");
  if (code) code.textContent = url;
  const copy = root.querySelector('#brainCard [data-copy]');
  // Update the first copy button in the brain card voice row
  const voiceRow = root.querySelector("#brainVoiceUrl")?.parentElement?.querySelector("[data-copy]");
  if (voiceRow) voiceRow.dataset.copy = url;
}

function bindBrainCard(root, initialAgentId) {
  const form = root.querySelector("#brainForm");
  const note = root.querySelector("#brainNote");
  const pick = root.querySelector("#agentPick");
  const fillAgents = async () => {
    const brain = normalizeAgentsBaseUrl(form.agents_url.value || account.agents_public_url || "");
    note.textContent = "Loading agents…";
    try {
      const agents = await fetchAgentsList(brain);
      const current = pick.value || initialAgentId || localStorage.getItem("cx-agent-id") || "";
      pick.innerHTML = `<option value="">Default agent</option>` + agents.map((agent) =>
        `<option value="${esc(agent.id)}" ${agent.id === current ? "selected" : ""}>${esc(agent.name || agent.id)}</option>`
      ).join("");
      note.textContent = agents.length ? `Loaded ${agents.length} agent${agents.length === 1 ? "" : "s"} from ${brain}.` : `No agents at ${brain}.`;
      refreshBrainVoiceDisplay(root, pick.value);
    } catch (error) {
      note.textContent = error.message || "Could not load agents. Paste an agent id manually in the Voice URL.";
    }
  };
  root.querySelector("#loadAgents")?.addEventListener("click", () => fillAgents());
  pick?.addEventListener("change", () => {
    localStorage.setItem("cx-agent-id", pick.value || "");
    refreshBrainVoiceDisplay(root, pick.value);
    bindCopies(root);
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const brain = normalizeAgentsBaseUrl(form.agents_url.value || "");
    form.agents_url.value = brain;
    localStorage.setItem("cx-agents-url", brain);
    localStorage.setItem("cx-agent-id", pick.value || "");
    if (brain) {
      account.agents_public_url = brain;
      account.voice_webhook_url = `${brain}/twilio/voice`;
      account.status_callback_url = `${brain}/twilio/status`;
    }
    refreshBrainVoiceDisplay(root, pick.value);
    bindCopies(root);
    note.textContent = "Saved in this browser. Use the Voice URL below on numbers and TwiML Apps.";
  });
  root.querySelector("#applyVoiceUrls")?.addEventListener("click", async () => {
    clearError();
    const agentId = pick.value || "";
    const confirmMsg = agentId
      ? `Overwrite Voice URL on EVERY number with agentId=${agentId}? Existing bindings will change.`
      : "Overwrite Voice URL on EVERY number with the default (no agentId)? Existing bindings will be cleared.";
    if (!window.confirm(confirmMsg)) return;
    note.textContent = agentId
      ? `Applying Voice URL with agentId=${agentId} to all numbers…`
      : "Applying default Voice URL (no agentId) to all numbers…";
    try {
      const listed = await api(resourcePath("/IncomingPhoneNumbers"));
      const numbers = listed.incoming_phone_numbers || [];
      if (!numbers.length) {
        note.textContent = "No numbers to update. Buy a demo number first.";
        return;
      }
      let ok = 0;
      for (const number of numbers) {
        await api("/api/twilio/v1/assign-agent", {
          method: "POST",
          body: JSON.stringify({ sid: number.sid, agent_id: agentId }),
        });
        ok += 1;
      }
      localStorage.setItem("cx-agent-id", agentId);
      note.textContent = `Updated Voice URL on ${ok} number${ok === 1 ? "" : "s"}. Binding shows on Agents → Phone Numbers.`;
    } catch (error) {
      note.textContent = "";
      showError(error);
    }
  });
  root.querySelector("#demoCall")?.addEventListener("click", async () => {
    clearError();
    note.textContent = "Running demo call to Agents…";
    const brain = normalizeAgentsBaseUrl(form.agents_url.value || account.agents_public_url || "");
    try {
      const result = await api("/api/twilio/v1/demo-call", {
        method: "POST",
        body: JSON.stringify({
          agents_base_url: brain || undefined,
          agent_id: pick.value || undefined,
        }),
      });
      const bits = [];
      if (result.uses_stream) bits.push("Media Stream TwiML");
      if (result.uses_say_stub) bits.push("Say stub (unexpected)");
      if (result.media?.audioFrames) bits.push(`${result.media.audioFrames} audio frame(s) from Realtime`);
      else if (result.media?.connected) bits.push("stream connected, no audio yet");
      if (result.media?.error) bits.push(result.media.error);
      note.textContent = `Demo call ${result.call_sid}: ${bits.join(" · ") || "done"}.`;
      if (!result.ok) showError(new Error(result.media?.error || "Agents did not return Media Stream TwiML"));
    } catch (error) {
      note.textContent = "";
      showError(error);
    }
  });
  if (initialAgentId || savedBrainHasAgents(form)) {
    fillAgents().catch(() => {});
  }
}

function savedBrainHasAgents(form) {
  return Boolean(form?.agents_url?.value?.trim() || account?.agents_public_url);
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
      <td>${number.agent_id ? `<span class="mono">${esc(number.agent_id)}</span>` : `<span class="sub">Unassigned</span>`}</td>
      <td class="mono">${esc(number.voice_url || "—")}</td>
      <td>${esc(caps(number.capabilities))}</td>
      <td><span class="cx-pill ${pillClass(number.status)}">${esc(statusLabel(number.status))}</span></td>
    </tr>
  `).join("") : emptyRow(6, "No numbers on this account.");
  view.innerHTML = `
    ${head("Phone Numbers", "Active numbers", account.demo ? "These rows live in SQLite. Buying one here does not create it on Twilio. Connect by pasting Agents …/twilio/voice?agentId=… into Voice URL." : "These rows come from the connected Twilio account. Connect by pasting Agents …/twilio/voice?agentId=… into Voice URL.", `<a class="cx-btn primary" href="${cxPath("/phone-numbers/search")}" data-cx>Buy a number</a>`)}
    <div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Number</th><th>Friendly name</th><th>Agent</th><th>Voice URL</th><th>Capabilities</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
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
  const linkedAgent = number.agent_id || parseAgentIdFromVoiceUrl(number.voice_url) || "";
  const savedAgent = localStorage.getItem("cx-agent-id") || "";
  openDrawer(formatPhone(number.phone_number), number.sid, `
    ${number.demo ? `<p class="cx-note">Demo number. It is stored on this server and was not purchased on Twilio.</p>` : `<p class="cx-note">This number is on the connected Twilio account. Saving updates it there.</p>`}
    <p class="cx-lede" style="margin-bottom:12px">Primary connect path: paste an Agents Voice URL ending in <span class="mono">?agentId=&lt;id&gt;</span>, then save. Binding is read from that query.</p>
    <dl class="cx-dl">
      <dt>Friendly name</dt><dd>${esc(number.friendly_name)}</dd>
      <dt>Capabilities</dt><dd>${esc(caps(number.capabilities))}</dd>
      <dt>Status</dt><dd>${esc(statusLabel(number.status))}</dd>
      <dt>Created</dt><dd>${esc(formatWhen(number.date_created))}</dd>
    </dl>
    <form class="cx-form" id="numberForm">
      <label>Friendly name<input name="friendly_name" value="${esc(number.friendly_name)}" required></label>
      <label>Voice URL (connect control)<input name="voice_url" id="drawerVoiceUrl" value="${esc(absoluteUrl(number.voice_url))}" placeholder="${esc(account.voice_webhook_url)}?agentId=…" spellcheck="false"></label>
      <p class="cx-lede" id="parsedAgentNote" style="margin-top:-4px">Parsed agent id: ${linkedAgent ? `<span class="mono">${esc(linkedAgent)}</span>` : "<em>none (default agent)</em>"}</p>
      <label>Voice method<select name="voice_method"><option ${number.voice_method === "GET" ? "" : "selected"}>POST</option><option ${number.voice_method === "GET" ? "selected" : ""}>GET</option></select></label>
      <label>Status callback URL<input name="status_callback" value="${esc(absoluteUrl(number.status_callback))}" placeholder="${esc(account.status_callback_url)}"></label>
      <label>Status callback method<select name="status_callback_method"><option ${number.status_callback_method === "GET" ? "" : "selected"}>POST</option><option ${number.status_callback_method === "GET" ? "selected" : ""}>GET</option></select></label>
      <div class="cx-actions">
        <button class="cx-btn primary" type="submit">Save number</button>
        <button class="cx-btn ghost" type="button" data-copy="${esc(absoluteUrl(number.voice_url))}">Copy Voice URL</button>
      </div>
    </form>
    <details style="margin-top:18px">
      <summary class="cx-lede" style="cursor:pointer">Optional: one-click apply agent</summary>
      <div class="cx-form" style="margin-top:10px">
        <label>Agent
          <select id="drawerAgentPick">
            <option value="">Unassigned (default agent)</option>
          </select>
        </label>
        <div class="cx-actions" style="margin-top:10px">
          <button class="cx-btn ghost" type="button" id="assignDrawerAgent">Apply agent (writes Voice URL)</button>
          <button class="cx-btn ghost" type="button" id="clearAgent" ${linkedAgent ? "" : "disabled"}>Clear agentId</button>
        </div>
        <p class="cx-lede" id="drawerAgentNote" style="margin-top:8px"></p>
      </div>
    </details>
  `, (root) => {
    const pick = root.querySelector("#drawerAgentPick");
    const noteEl = root.querySelector("#drawerAgentNote");
    const voiceInput = root.querySelector("#drawerVoiceUrl");
    const parsedNote = root.querySelector("#parsedAgentNote");
    const preferred = linkedAgent || savedAgent || "";

    const refreshParsed = () => {
      const id = parseAgentIdFromVoiceUrl(voiceInput?.value || "");
      if (parsedNote) {
        parsedNote.innerHTML = id
          ? `Parsed agent id: <span class="mono">${esc(id)}</span> — saving binds this number to that agent.`
          : `Parsed agent id: <em>none (default agent)</em> — saving clears the agentId query.`;
      }
      const clearBtn = root.querySelector("#clearAgent");
      if (clearBtn) clearBtn.disabled = !id;
      const copyBtn = root.querySelector("#numberForm [data-copy]");
      if (copyBtn && voiceInput) copyBtn.dataset.copy = voiceInput.value || "";
    };
    voiceInput?.addEventListener("input", refreshParsed);
    refreshParsed();
    bindCopies(root);

    (async () => {
      try {
        const brain = normalizeAgentsBaseUrl(account?.agents_public_url || localStorage.getItem("cx-agents-url") || "");
        const agents = brain ? await fetchAgentsList(brain) : [];
        if (!agents.length) {
          pick.innerHTML = `<option value="">Unassigned (default agent)</option>` +
            (preferred ? `<option value="${esc(preferred)}" selected>${esc(preferred)}</option>` : "");
          if (noteEl) noteEl.textContent = brain
            ? "No agents returned from Agents. Paste a Voice URL above instead."
            : "Set Agents brain URL on Overview to load the agent list, or paste a Voice URL above.";
          return;
        }
        pick.innerHTML = `<option value="">Unassigned (default agent)</option>` + agents.map((agent) =>
          `<option value="${esc(agent.id)}" ${agent.id === preferred ? "selected" : ""}>${esc(agent.name || agent.id)}</option>`
        ).join("");
        if (preferred && ![...pick.options].some((option) => option.value === preferred)) {
          const orphan = document.createElement("option");
          orphan.value = preferred;
          orphan.textContent = preferred;
          orphan.selected = true;
          pick.append(orphan);
        }
        pick.addEventListener("change", () => {
          const next = pick.value || "";
          if (voiceInput) {
            voiceInput.value = brainVoiceUrl(next);
            refreshParsed();
          }
        });
      } catch (error) {
        if (noteEl) noteEl.textContent = error.message || "Could not load agents.";
        if (preferred) {
          pick.innerHTML = `<option value="">Unassigned (default agent)</option><option value="${esc(preferred)}" selected>${esc(preferred)}</option>`;
        }
      }
    })();
    root.querySelector("#assignDrawerAgent")?.addEventListener("click", async () => {
      try {
        const agentId = pick.value || "";
        await api("/api/twilio/v1/assign-agent", {
          method: "POST",
          body: JSON.stringify({ sid, agent_id: agentId }),
        });
        if (agentId) localStorage.setItem("cx-agent-id", agentId);
        closeDrawer();
        await numbersPage();
      } catch (error) {
        showError(error);
      }
    });
    root.querySelector("#clearAgent")?.addEventListener("click", async () => {
      try {
        await api("/api/twilio/v1/assign-agent", {
          method: "POST",
          body: JSON.stringify({ sid, agent_id: "" }),
        });
        closeDrawer();
        await numbersPage();
      } catch (error) {
        showError(error);
      }
    });
    root.querySelector("#numberForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const voiceUrl = String(form.get("voice_url") || "");
      const parsedId = parseAgentIdFromVoiceUrl(voiceUrl);
      try {
        await api(resourcePath(`/IncomingPhoneNumbers/${sid}`), {
          method: "POST",
          body: JSON.stringify({
            friendly_name: form.get("friendly_name"),
            voice_url: voiceUrl,
            voice_method: form.get("voice_method"),
            status_callback: form.get("status_callback"),
            status_callback_method: form.get("status_callback_method"),
          }),
        });
        if (parsedId) localStorage.setItem("cx-agent-id", parsedId);
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
    navigate(`${cxPath("/phone-numbers/search")}?${next}`);
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
        history.pushState({}, "", cxPath("/phone-numbers"));
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
    ${makeCallCardHtml({ compact: false })}
    <form class="cx-filters" id="callFilters">
      <label>Status<select name="status">${statuses.map((status) => `<option value="${esc(status)}" ${params.get("status") === status ? "selected" : ""}>${esc(status ? statusLabel(status) : "Any")}</option>`).join("")}</select></label>
      <label>Direction<select name="direction"><option value="">Any</option><option value="inbound" ${params.get("direction") === "inbound" ? "selected" : ""}>Inbound</option><option value="outbound" ${params.get("direction") === "outbound" ? "selected" : ""}>Outbound</option></select></label>
      <label>From<input name="from" value="${esc(params.get("from") || "")}" placeholder="client:browser"></label>
      <button class="cx-btn" type="submit">Filter</button>
    </form>
    ${callsTable(data.calls || [], "No calls match.")}
  `;
  bindMakeCallForm(view);
  view.querySelector("#callFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (form.get("status")) next.set("status", form.get("status"));
    if (form.get("direction")) next.set("direction", form.get("direction"));
    if (form.get("from")) next.set("from", form.get("from"));
    const search = next.toString();
    navigate(`${cxPath("/voice/calls")}${search ? `?${search}` : ""}`);
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
    ${(() => {
      const brain = normalizeAgentsBaseUrl(account?.agents_public_url || "");
      if (!call.local_call_id || !brain) return "";
      return `<p><a href="${esc(brain + "/history/" + call.local_call_id)}" target="_blank" rel="noopener">Open the agent transcript</a></p>`;
    })()}
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
      <p>Use POST. The voice webhook on Agents returns Connect/Stream into OpenAI Realtime.</p>
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
    const path = location.pathname.replace(/\/$/, "") || (CONSOLE_BASE || "/");
    const root = CONSOLE_BASE || "/";
    if (path === root || path === "/") await overview();
    else if (path === cxPath("/phone-numbers")) await numbersPage();
    else if (path === cxPath("/phone-numbers/search")) await buyPage();
    else if (path === cxPath("/voice/calls")) await callsPage();
    else if (path === cxPath("/develop/twiml-apps")) await appsPage();
    else if (path === cxPath("/monitor/logs")) await logsPage();
    else if (path === cxPath("/account/keys")) await keysPage();
    else view.innerHTML = `${head("Telephony", "Not found", "")}<p class="cx-lede">That console page is not available. <a href="${cxPath()}" data-cx>Back to overview</a></p>`;
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
