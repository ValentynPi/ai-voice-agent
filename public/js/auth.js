const form = document.querySelector("#authForm");
const title = document.querySelector("#title");
const lede = document.querySelector("#lede");
const submit = document.querySelector("#submit");
const switchEl = document.querySelector("#switch");
const nameField = document.querySelector("#name");
const errorEl = document.querySelector("#error");
const demoLink = document.querySelector("#demoLink");

const mode = location.pathname.startsWith("/signin") ? "signin" : "signup";

if (mode === "signin") {
  title.textContent = "Sign in";
  lede.textContent = "Open your empty workspace, or sign in to an existing account.";
  submit.textContent = "Sign in";
  nameField.closest("label").hidden = true;
  document.querySelector("#password").autocomplete = "current-password";
  switchEl.innerHTML = 'Need an account? <a href="/signup">Create one</a>';
}

demoLink.addEventListener("click", async (event) => {
  event.preventDefault();
  await fetch("/api/auth/demo", { method: "POST", credentials: "same-origin" });
  location.href = "/agents";
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
    location.href = "/agents";
  } catch (error) {
    errorEl.hidden = false;
    errorEl.textContent = error.message || "Could not continue";
  }
});
