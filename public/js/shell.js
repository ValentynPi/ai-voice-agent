const current = document.body.dataset.nav || "";
for (const link of document.querySelectorAll(".side-nav a[data-nav]")) {
  if (link.dataset.nav === current) link.setAttribute("aria-current", "page");
}

const pill = document.querySelector("#statusPill");

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

ping();
setInterval(ping, 15000);
