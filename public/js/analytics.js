import { emptyState, formatDuration, formatWhen, readJson, statusClass, statusLabel } from "./ui.js";

const statCount = document.querySelector("#statCount");
const statDuration = document.querySelector("#statDuration");
const statRate = document.querySelector("#statRate");
const statSplit = document.querySelector("#statSplit");
const statWeek = document.querySelector("#statWeek");
const chart = document.querySelector("#chart");
const chartNote = document.querySelector("#chartNote");
const recent = document.querySelector("#recent");

function weekday(date) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function renderChart(volume) {
  chart.replaceChildren();
  const max = Math.max(1, ...volume.map((day) => day.count));
  for (const day of volume) {
    const column = document.createElement("div");
    column.className = "bar";
    const count = document.createElement("b");
    count.textContent = String(day.count);
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(4, Math.round((day.count / max) * 120))}px`;
    const label = document.createElement("em");
    label.textContent = weekday(day.date);
    column.append(count, bar, label);
    chart.append(column);
  }
}

function renderRecent(calls) {
  recent.replaceChildren();
  if (!calls.length) {
    recent.append(emptyState("Nothing to chart yet", "Finish a web test call and the volume, duration, and completion rate fill in from that record."));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data";
  const body = document.createElement("tbody");
  for (const call of calls.slice(0, 5)) {
    const row = document.createElement("tr");
    const when = document.createElement("td");
    const link = document.createElement("a");
    link.href = `/history/${encodeURIComponent(call.id)}`;
    link.textContent = formatWhen(call.startedAt);
    when.append(link);
    const agent = document.createElement("td");
    agent.textContent = call.agentName || "Unknown agent";
    const duration = document.createElement("td");
    duration.textContent = formatDuration(call.durationMs);
    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `pill ${statusClass(call.status)}`;
    pill.textContent = statusLabel(call.status);
    status.append(pill);
    row.append(when, agent, duration, status);
    body.append(row);
  }
  table.append(body);
  wrap.append(table);
  recent.append(wrap);
}

async function load() {
  try {
    const [stats, history] = await Promise.all([
      readJson(await fetch("/api/analytics")),
      readJson(await fetch("/api/history")),
    ]);
    statCount.textContent = String(stats.callCount);
    statDuration.textContent = stats.avgDurationMs == null ? "—" : formatDuration(stats.avgDurationMs);
    statRate.textContent = stats.completionRate == null ? "—" : `${Math.round(stats.completionRate * 100)}%`;
    statSplit.textContent = stats.callCount ? `${stats.completed} completed · ${stats.failed} failed` : "No failed calls";
    const week = (stats.recentVolume || []).reduce((sum, day) => sum + day.count, 0);
    statWeek.textContent = String(week);
    chartNote.textContent = stats.callCount
      ? "Web test calls per day, UTC."
      : "No web test calls yet. Open an agent and start a test call.";
    renderChart(stats.recentVolume || []);
    renderRecent(history.calls || []);
  } catch (error) {
    chartNote.textContent = error.message || "Analytics could not load.";
  }
}

load();
