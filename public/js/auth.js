const form = document.querySelector("#authForm");
const title = document.querySelector("#title");
const lede = document.querySelector("#lede");
const submit = document.querySelector("#submit");
const switchEl = document.querySelector("#switch");
const nameField = document.querySelector("#name");
const errorEl = document.querySelector("#error");
const demoLink = document.querySelector("#demoLink");
const cancel = document.querySelector("#cancelLink");

const mode = location.pathname.startsWith("/signin") ? "signin" : "signup";
const nextParam = new URLSearchParams(location.search).get("next") || "/agents";
const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/agents";

if (mode === "signin") {
  title.textContent = "Sign in";
  lede.textContent = "Open your workspace. New accounts stay empty until you add agents and MCP tools.";
  submit.textContent = "Sign in";
  nameField.closest("label").hidden = true;
  document.querySelector("#password").autocomplete = "current-password";
  switchEl.innerHTML = 'Need an account? <a href="/signup">Create one</a>';
}

if (cancel) cancel.href = "/signin";

async function refreshDemoLink() {
  if (!demoLink) return;
  try {
    const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.json());
    if (me?.security?.authRequired) {
      demoLink.closest("p")?.remove();
    }
  } catch {
    /* keep link in local/all mode */
  }
}

demoLink?.addEventListener("click", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/auth/demo", { method: "POST", credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    errorEl.hidden = false;
    errorEl.textContent = body.error || "Demo browsing is disabled. Sign in instead.";
    return;
  }
  location.href = safeNext;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  const body = {
    email: document.querySelector("#email").value,
    password: document.querySelector("#password").value,
  };
  if (mode === "signup") body.name = document.querySelector("#name").value;
  try {
    const response = await fetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/signin", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Request failed");
    location.href = safeNext;
  } catch (error) {
    errorEl.hidden = false;
    errorEl.textContent = error.message || "Could not continue";
  }
});

refreshDemoLink();
