const current = document.body.dataset.nav || "";
for (const link of document.querySelectorAll(".side-nav a[data-nav]")) {
  if (link.dataset.nav === current) link.setAttribute("aria-current", "page");
}

const pill = document.querySelector("#statusPill");
const foot = document.querySelector(".sidebar-foot");

function paintPill(online) {
  if (!pill) return;
  pill.classList.toggle("offline", !online);
  if (pill.lastChild) pill.lastChild.textContent = online ? " Online" : " Offline";
}

async function ping() {
  if (!pill || document.body.dataset.nav === "tools") return;
  try {
    const response = await fetch("/api/health");
    paintPill(response.ok);
  } catch {
    paintPill(false);
  }
}

function ensureAuthSlot() {
  if (!foot) return null;
  let slot = foot.querySelector("#accountSlot");
  if (slot) return slot;
  slot = document.createElement("div");
  slot.id = "accountSlot";
  slot.className = "account-slot";
  foot.prepend(slot);
  return slot;
}

async function paintAccount() {
  const slot = ensureAuthSlot();
  if (!slot) return;
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    const body = await response.json();
    slot.replaceChildren();
    const label = document.createElement("p");
    label.className = "account-label";
    if (body.signedIn && body.account) {
      label.textContent = body.account.email;
      const actions = document.createElement("div");
      actions.className = "account-actions";
      const out = document.createElement("button");
      out.type = "button";
      out.className = "btn ghost tiny";
      out.textContent = "Sign out";
      out.addEventListener("click", async () => {
        await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" });
        location.href = "/agents";
      });
      actions.append(out);
      slot.append(label, actions);
    } else {
      label.textContent = "Public demo";
      const actions = document.createElement("div");
      actions.className = "account-actions";
      const signin = document.createElement("a");
      signin.className = "btn ghost tiny";
      signin.href = "/signin";
      signin.textContent = "Sign in";
      const signup = document.createElement("a");
      signup.className = "btn primary tiny";
      signup.href = "/signup";
      signup.textContent = "Create account";
      actions.append(signin, signup);
      slot.append(label, actions);
    }
  } catch {
    /* ignore */
  }
}

ping();
paintAccount();
setInterval(ping, 15000);
