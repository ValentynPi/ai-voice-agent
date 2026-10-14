import { readJson } from "./ui.js";

const list = document.querySelector("#settings");
const securityList = document.querySelector("#securitySettings");
const securityActions = document.querySelector("#securityActions");

function row(label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  return [term, detail];
}

async function loadSecurity() {
  if (!securityList) return;
  try {
    const me = await readJson(await fetch("/api/auth/me", { credentials: "same-origin" }));
    securityList.replaceChildren();
    if (!me.signedIn) {
      securityList.append(...row("Session", "Not signed in"));
      securityList.append(...row("Access", "Sign in required for the Agents console"));
      if (securityActions) {
        securityActions.replaceChildren();
        const a = document.createElement("a");
        a.className = "btn primary";
        a.href = "/signin";
        a.textContent = "Sign in";
        securityActions.append(a);
      }
      return;
    }
    const sec = me.security || {};
    securityList.append(
      ...row("Signed in as", me.account?.email || "—"),
      ...row("Account id", me.account?.id || "—"),
      ...row("Session cookie", sec.sessionCookie || "vd_session"),
      ...row("Cookie flags", (sec.cookieFlags || []).join(" · ") || "HttpOnly · SameSite=Lax"),
      ...row("Tenant isolation", sec.tenantIsolation || "Per-account data only"),
      ...row("API keys", "OpenAI and MCP tokens stay on the server — not shown in the browser"),
    );
    if (securityActions) {
      securityActions.replaceChildren();
      const out = document.createElement("button");
      out.type = "button";
      out.className = "btn ghost";
      out.textContent = "Sign out";
      out.addEventListener("click", async () => {
        await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" });
        location.href = "/signin";
      });
      securityActions.append(out);
    }
  } catch (error) {
    securityList.replaceChildren(...row("Status", error.message || "Could not load security."));
  }
}

async function load() {
  let telephony = "Open Phone Numbers.";
  try {
    const numbers = await readJson(await fetch("/api/phone-numbers"));
    const count = (numbers.incoming_phone_numbers || []).length;
    const where = numbers.source === "telephony" ? "synced from telephony" : "local store";
    telephony = numbers.mode === "connected"
      ? `Connected · ${count} number${count === 1 ? "" : "s"} (${where})`
      : `Demo · ${count} number${count === 1 ? "" : "s"} (${where})`;
  } catch {
    telephony = "Phone Numbers unavailable.";
  }
  try {
    const state = await readJson(await fetch("/api/state"));
    const pairs = [
      ["OpenAI", state.openai ? "Key configured" : "No API key on this server"],
      ["Chat model", state.model || "Unavailable without a key"],
      ["Realtime model", state.realtimeModel || "Unavailable without a key"],
      ["Default voice", state.voice || "chloe"],
      ["Database", state.database?.path || "sqlite"],
      ["Database note", state.database?.note || ""],
      ["MCP", state.mcp?.connected ? `Connected · ${state.mcp.url}` : "Not connected"],
      ["MCP token", state.mcp?.hasToken ? "Stored on the server" : "None stored"],
      ["Telephony", telephony],
    ];
    list.replaceChildren();
    for (const [label, value] of pairs) list.append(...row(label, value));
  } catch (error) {
    list.replaceChildren(...row("Status", error.message || "Could not load settings."));
  }
}

loadSecurity();
load();
