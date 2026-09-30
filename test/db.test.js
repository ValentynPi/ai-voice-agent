import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bookAppointment, getCatalog, listAppointments, listCustomers, reopenDatabase, resetDatabase } from "../src/db.js";
import { app } from "../src/server.js";
import { buildRealtimeSession } from "../src/realtime.js";
import { resetStore, startCall } from "../src/store.js";
import { executeTool } from "../src/tools/registry.js";

test.beforeEach(() => {
  resetDatabase();
});

test("first boot seeds the salon tables from the demo data", () => {
  const catalog = getCatalog();
  assert.equal(catalog.customers.length, 3);
  assert.ok(catalog.customers.some((customer) => customer.name === "Ana Ruiz" && customer.nextAppointment?.service === "Balayage and cut"));
  assert.ok(catalog.orders.some((order) => order.id === "ORD-1042" && order.totalEur === 145));
  assert.equal(catalog.services.length, 6);
  assert.equal(catalog.staff.length, 3);
  assert.ok(catalog.hours.days.some((day) => day.day === "Tuesday" && day.open === "10:00"));
  assert.equal(listCustomers().length, 3);
});

test("booking writes an appointment and a pending order", async () => {
  resetStore();
  const call = startCall();
  const outcome = await executeTool({
    callId: call.id,
    name: "book_appointment",
    args: {
      customer: "Ana Ruiz",
      service: "Men's cut",
      date: "2026-10-06",
      time: "12:00",
      stylist: "Núria Palau",
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.booked, true);
  assert.equal(outcome.result.order.status, "pending");
  assert.equal(outcome.result.order.totalEur, 28);
  const listed = listAppointments();
  assert.ok(listed.appointments.some((item) => item.customer === "Ana Ruiz" && item.time === "12:00" && item.service === "Men's cut"));
  assert.ok(getCatalog().orders.some((order) => order.id === outcome.result.order.id));
});

test("tool edits and salon rows survive a sqlite reopen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-db-"));
  const file = path.join(dir, "salon.sqlite");
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = file;
  try {
    resetDatabase();
    const created = bookAppointment({
      customer: "Lucía Ferrer",
      service: "Keratin treatment",
      date: "2026-10-08",
      time: "09:30",
    });
    assert.equal(created.booked, true);
    const { updateTool } = await import("../src/tools/catalog.js");
    updateTool("get_weather", { description: "Castellón weather, edited." });
    reopenDatabase();
    const catalog = getCatalog();
    assert.equal(catalog.customers.length, 3);
    assert.ok(catalog.orders.some((order) => order.id === created.order.id));
    const { listToolCatalog } = await import("../src/tools/registry.js");
    const weather = listToolCatalog().find((tool) => tool.name === "get_weather");
    assert.equal(weather.description, "Castellón weather, edited.");
    assert.equal(weather.enabled, true);
  } finally {
    process.env.DATABASE_PATH = previous;
    resetDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer(fn) {
  resetStore();
  resetDatabase();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("dashboard can edit the tool catalog stored in sqlite", async () => {
  await withServer(async (base) => {
    const listed = await fetch(`${base}/api/tools`).then((response) => response.json());
    assert.ok(listed.tools.some((tool) => tool.name === "get_weather" && tool.enabled && tool.parameterSummary));
    assert.equal(listed.storage.database, "sqlite");

    const created = await fetch(`${base}/api/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "lookup_note",
        group: "crm",
        description: "Read a fictional desk note.",
        fields: ["name"],
        mock: { ok: true, note: "Window seat." },
      }),
    });
    assert.equal(created.status, 201);

    const renamed = await fetch(`${base}/api/tools/lookup_note`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Read the fictional desk note for a client.", enabled: true }),
    });
    assert.equal(renamed.status, 200);

    const disabled = await fetch(`${base}/api/tools/query_hours`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);

    const session = buildRealtimeSession("gpt-realtime-2.1", "en");
    assert.equal(session.tools.some((tool) => tool.name === "lookup_note"), false);
    assert.equal(session.tools.some((tool) => tool.name === "query_hours"), false);
    assert.equal(session.tools.some((tool) => tool.name === "get_weather"), false);

    const { call } = await fetch(`${base}/api/calls`, { method: "POST" }).then((response) => response.json());
    const outcome = await executeTool({
      callId: call.id,
      name: "lookup_note",
      args: { name: "Ana" },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.note, "Window seat.");

    const weatherGone = await fetch(`${base}/api/tools/get_weather`, { method: "DELETE" });
    assert.equal(weatherGone.status, 400);
    assert.match((await weatherGone.json()).error, /Weather tools stay registered/);

    const removed = await fetch(`${base}/api/tools/lookup_note`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(buildRealtimeSession("gpt-realtime-2.1", "en").tools.some((tool) => tool.name === "lookup_note"), false);
    const listedAfter = await fetch(`${base}/api/tools`).then((response) => response.json());
    assert.equal(listedAfter.tools.some((tool) => tool.name === "lookup_note"), false);
  });
});
