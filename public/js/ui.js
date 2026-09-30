export function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Madrid",
  }).format(date);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function statusLabel(status) {
  if (status === "in_progress") return "In progress";
  if (status === "failed") return "Failed";
  if (status === "completed") return "Completed";
  return status || "Unknown";
}

export function statusClass(status) {
  if (status === "failed") return "bad";
  if (status === "completed") return "ok";
  return "";
}

export function emptyState(title, text) {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = text;
  wrap.append(heading, copy);
  return wrap;
}

export async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}
