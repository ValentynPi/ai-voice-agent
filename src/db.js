import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_KB_ID,
  DEFAULT_SYSTEM_PROMPT,
  GREETING_EN,
  GREETING_ES,
} from "./defaults.js";
import { ensureTwilioTables } from "./twilio/schema.js";
import { CUSTOMERS, HOURS, ORDERS, SALON, SERVICES, STAFF } from "./tools/demo-data.js";

let db = null;
let dbPath = null;
const readyListeners = new Set();

export function onDatabaseReady(fn) {
  readyListeners.add(fn);
  if (db) fn();
}

function emitDatabaseReady() {
  for (const fn of readyListeners) fn();
}

export function configuredDatabasePath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (process.env.NODE_ENV === "test") return ":memory:";
  return path.join(process.cwd(), "data", "maison-sol.sqlite");
}

function publicPath(file) {
  if (!file || file === ":memory:") return ":memory:";
  if (file.includes("/home/") || file.includes("/Users/")) return path.basename(file);
  return file;
}

export function databaseInfo() {
  const file = dbPath || configuredDatabasePath();
  const memory = file === ":memory:";
  return {
    driver: "sqlite",
    path: publicPath(file),
    memory,
    note: memory
      ? "This process is using an in-memory SQLite database."
      : "SQLite file set by DATABASE_PATH, or data/maison-sol.sqlite. Fly's disk is ephemeral unless you attach a volume, so the file is lost when the machine stops.",
  };
}

function connect(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
  migrate(database);
  seedIfNeeded(database);
  db = database;
  dbPath = file;
  emitDatabaseReady();
}

export function getDb() {
  if (!db) connect(configuredDatabasePath());
  return db;
}

export function initDatabase() {
  getDb();
  return databaseInfo();
}

export function closeDatabase() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
}

export function resetDatabase() {
  closeDatabase();
  const file = configuredDatabasePath();
  if (file !== ":memory:") {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${file}${suffix}`;
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
  }
  connect(file);
}

export function reopenDatabase() {
  const file = dbPath || configuredDatabasePath();
  closeDatabase();
  connect(file);
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS salon (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      timezone TEXT NOT NULL,
      hours_note TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hours (
      day TEXT PRIMARY KEY,
      open TEXT,
      close TEXT,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      days TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      price_eur INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      loyalty TEXT,
      notes TEXT,
      last_visit TEXT
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      stylist_name TEXT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      service TEXT NOT NULL,
      stylist TEXT,
      status TEXT NOT NULL,
      date TEXT,
      time TEXT,
      total_eur INTEGER
    );
    CREATE TABLE IF NOT EXISTS tool_definitions (
      name TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      description TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 0,
      mock_json TEXT
    );
    CREATE TABLE IF NOT EXISTS mcp_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      url TEXT NOT NULL,
      auth_token TEXT,
      server_name TEXT,
      protocol_version TEXT,
      connected INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_tools (
      name TEXT PRIMARY KEY,
      alias TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      greeting_en TEXT NOT NULL DEFAULT '',
      greeting_es TEXT NOT NULL DEFAULT '',
      voice TEXT NOT NULL DEFAULT 'marin',
      language TEXT NOT NULL DEFAULT 'multi',
      model_notes TEXT NOT NULL DEFAULT '',
      enabled_tools_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_knowledge (
      agent_id TEXT NOT NULL,
      knowledge_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, knowledge_id)
    );
    CREATE TABLE IF NOT EXISTS call_records (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      agent_name TEXT,
      source TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      transcript_json TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      voice TEXT,
      language TEXT,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_call_records_started ON call_records (started_at);
  `);
  ensureTwilioTables(database);
  seedProduct(database);
}

function salonKnowledge() {
  const open = HOURS.days.filter((day) => day.open).map((day) => `${day.day} ${day.open}–${day.close}`).join(", ");
  const closed = HOURS.days.filter((day) => !day.open).map((day) => day.day).join(" and ");
  const people = STAFF.map((person) => `${person.name} (${person.role}, ${person.days})`).join("; ");
  const services = SERVICES.map((item) => `${item.name} (${item.minutes} min, ${item.priceEur} euros)`).join("; ");
  return [
    `${SALON.name} is a fictional hair salon at ${SALON.address}.`,
    `Timezone ${SALON.timezone}. Open: ${open}. Closed: ${closed}.`,
    HOURS.note,
    `Stylists: ${people}.`,
    `Services: ${services}.`,
    "Use tools for customers, appointments, orders, and live weather. Do not invent those records from this note.",
  ].join(" ");
}

function seedProduct(database) {
  const seeded = database.prepare("SELECT value FROM meta WHERE key = 'product_seeded'").get();
  if (seeded) return;
  const now = new Date().toISOString();
  database.exec("BEGIN");
  try {
    database.prepare(`
      INSERT INTO agents (
        id, name, description, system_prompt, greeting_en, greeting_es,
        voice, language, model_notes, enabled_tools_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'marin', 'multi', ?, NULL, ?, ?)
    `).run(
      DEFAULT_AGENT_ID,
      "Maison Sol",
      "Receptionist for the fictional salon in Castellón de la Plana. Speaks first, in English or Spanish.",
      DEFAULT_SYSTEM_PROMPT,
      GREETING_EN,
      GREETING_ES,
      "Spoken calls use the Realtime model from the server environment and this agent's voice. Typed fallback uses the chat model when a key is set.",
      now,
      now,
    );
    database.prepare(`
      INSERT INTO knowledge_bases (id, title, body, source_url, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(DEFAULT_KB_ID, "Maison Sol desk facts", salonKnowledge(), now, now);
    database.prepare("INSERT INTO agent_knowledge (agent_id, knowledge_id) VALUES (?, ?)").run(DEFAULT_AGENT_ID, DEFAULT_KB_ID);
    database.prepare("INSERT INTO meta (key, value) VALUES ('product_seeded', '1')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedIfNeeded(database) {
  const seeded = database.prepare("SELECT value FROM meta WHERE key = 'seeded'").get();
  if (seeded) return;
  database.exec("BEGIN");
  try {
    database.prepare(`
      INSERT INTO salon (id, name, city, address, timezone, hours_note)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(SALON.name, SALON.city, SALON.address, SALON.timezone, HOURS.note);
    const hour = database.prepare("INSERT INTO hours (day, open, close, sort_order) VALUES (?, ?, ?, ?)");
    HOURS.days.forEach((day, index) => hour.run(day.day, day.open, day.close, index));
    const staff = database.prepare("INSERT INTO staff (id, name, role, days) VALUES (?, ?, ?, ?)");
    for (const person of STAFF) staff.run(person.id, person.name, person.role, person.days);
    const service = database.prepare("INSERT INTO services (id, name, minutes, price_eur) VALUES (?, ?, ?, ?)");
    for (const item of SERVICES) service.run(item.id, item.name, item.minutes, item.priceEur);
    const customer = database.prepare(`
      INSERT INTO customers (id, name, phone, email, loyalty, notes, last_visit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const appointment = database.prepare(`
      INSERT INTO appointments (customer_id, service_name, stylist_name, date, time, status)
      VALUES (?, ?, ?, ?, ?, 'booked')
    `);
    for (const person of CUSTOMERS) {
      customer.run(person.id, person.name, person.phone, person.email, person.loyalty, person.notes, person.lastVisit);
      if (person.nextAppointment) {
        appointment.run(
          person.id,
          person.nextAppointment.service,
          person.nextAppointment.stylist,
          person.nextAppointment.date,
          person.nextAppointment.time,
        );
      }
    }
    const order = database.prepare(`
      INSERT INTO orders (id, customer_id, customer_name, service, stylist, status, date, time, total_eur)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of ORDERS) {
      const match = CUSTOMERS.find((person) => person.name === item.customer);
      order.run(item.id, match?.id || null, item.customer, item.service, item.stylist, item.status, item.date, item.time, item.totalEur);
    }
    database.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function norm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function orderId(value) {
  const digits = String(value ?? "").toUpperCase().replace(/[^0-9]/g, "");
  if (!digits) return "";
  return `ORD-${digits}`;
}

function nextAppointmentFor(customerId) {
  return getDb().prepare(`
    SELECT date, time, service_name AS service, stylist_name AS stylist
    FROM appointments
    WHERE customer_id = ? AND status = 'booked'
    ORDER BY date, time
    LIMIT 1
  `).get(customerId) || null;
}

function mapCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    loyalty: row.loyalty,
    notes: row.notes,
    lastVisit: row.last_visit,
    nextAppointment: nextAppointmentFor(row.id),
  };
}

export function listCustomers() {
  return getDb().prepare("SELECT * FROM customers ORDER BY name").all().map(mapCustomer);
}

function customerNames() {
  return getDb().prepare("SELECT name FROM customers ORDER BY name").all().map((row) => row.name);
}

export function listOrders({ status } = {}) {
  const wanted = norm(status);
  const rows = getDb().prepare(`
    SELECT id, customer_name AS customer, service, stylist, status, date, time, total_eur AS totalEur
    FROM orders
    ORDER BY date, time
  `).all();
  const orders = wanted ? rows.filter((order) => norm(order.status) === wanted) : rows;
  return { count: orders.length, orders };
}

export function getOrder({ id, customer } = {}) {
  const knownIds = getDb().prepare("SELECT id FROM orders ORDER BY id").all().map((row) => row.id);
  const select = `
    SELECT id, customer_name AS customer, service, stylist, status, date, time, total_eur AS totalEur
    FROM orders
  `;
  if (id) {
    const order = getDb().prepare(`${select} WHERE id = ?`).get(orderId(id));
    return order ? { found: true, order } : { found: false, knownIds };
  }
  if (customer) {
    const wanted = norm(customer);
    const order = getDb().prepare(`${select} ORDER BY date DESC`).all().find((item) => {
      const name = norm(item.customer);
      return name.includes(wanted) || wanted.includes(name.split(" ")[0]);
    });
    return order ? { found: true, order } : { found: false, knownIds };
  }
  return { found: false, hint: "Provide an order id or customer name.", knownIds };
}

export function lookupCustomer({ name } = {}) {
  const names = customerNames();
  const wanted = norm(name);
  if (!wanted) return { found: false, customers: names };
  const customer = listCustomers().find((item) => {
    const full = norm(item.name);
    return full.includes(wanted) || wanted.includes(full) || full.split(" ").some((part) => part === wanted);
  });
  if (!customer) return { found: false, customers: names };
  return { found: true, customer };
}

export function listAppointments() {
  const appointments = getDb().prepare(`
    SELECT c.name AS customer, c.id AS customerId, a.date, a.time,
           a.service_name AS service, a.stylist_name AS stylist
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    WHERE a.status = 'booked'
    ORDER BY a.date, a.time
  `).all();
  return { count: appointments.length, appointments };
}

export function queryServices({ q } = {}) {
  const wanted = norm(q);
  const services = getDb().prepare(`
    SELECT id, name, minutes, price_eur AS priceEur
    FROM services
    ORDER BY name
  `).all().filter((service) => !wanted || norm(service.name).includes(wanted));
  return { count: services.length, services };
}

export function queryStaff() {
  const staff = getDb().prepare("SELECT id, name, role, days FROM staff ORDER BY name").all();
  return { count: staff.length, staff };
}

export function queryHours() {
  const salon = getDb().prepare("SELECT name, city, address, timezone, hours_note FROM salon WHERE id = 1").get();
  const days = getDb().prepare("SELECT day, open, close FROM hours ORDER BY sort_order").all();
  return {
    timezone: salon?.timezone || SALON.timezone,
    address: salon?.address || SALON.address,
    note: salon?.hours_note || HOURS.note,
    days,
  };
}

export function getCatalog() {
  return {
    salon: SALON,
    hours: queryHours(),
    services: queryServices().services,
    staff: queryStaff().staff,
    customers: listCustomers(),
    orders: listOrders().orders,
  };
}

function findService(name) {
  const wanted = norm(name);
  if (!wanted) return null;
  return queryServices().services.find((service) => norm(service.name) === wanted || norm(service.name).includes(wanted));
}

function findStaff(name) {
  const wanted = norm(name);
  if (!wanted) return null;
  return queryStaff().staff.find((person) => norm(person.name) === wanted || norm(person.name).includes(wanted));
}

export function bookAppointment({ customer, service, date, time, stylist } = {}) {
  const match = lookupCustomer({ name: customer });
  if (!match.found) return { booked: false, customers: match.customers };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return { booked: false, error: "date must be YYYY-MM-DD" };
  }
  if (!/^\d{2}:\d{2}$/.test(String(time || ""))) {
    return { booked: false, error: "time must be HH:MM" };
  }
  const serviceRow = findService(service);
  if (!serviceRow) {
    return { booked: false, services: queryServices().services.map((item) => item.name) };
  }
  const staffRow = findStaff(stylist);
  const stylistName = staffRow?.name || null;
  const database = getDb();
  const numbers = database.prepare("SELECT id FROM orders").all()
    .map((row) => Number(String(row.id).replace(/\D/g, "")))
    .filter((value) => Number.isFinite(value));
  const next = Math.max(1000, ...numbers) + 1;
  const id = `ORD-${next}`;
  database.exec("BEGIN");
  try {
    database.prepare(`
      INSERT INTO appointments (customer_id, service_name, stylist_name, date, time, status)
      VALUES (?, ?, ?, ?, ?, 'booked')
    `).run(match.customer.id, serviceRow.name, stylistName, date, time);
    database.prepare(`
      INSERT INTO orders (id, customer_id, customer_name, service, stylist, status, date, time, total_eur)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, match.customer.id, match.customer.name, serviceRow.name, stylistName, date, time, serviceRow.priceEur);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    booked: true,
    appointment: {
      customer: match.customer.name,
      customerId: match.customer.id,
      date,
      time,
      service: serviceRow.name,
      stylist: stylistName,
    },
    order: {
      id,
      customer: match.customer.name,
      service: serviceRow.name,
      stylist: stylistName,
      status: "pending",
      date,
      time,
      totalEur: serviceRow.priceEur,
    },
  };
}

function mapTool(row) {
  return {
    name: row.name,
    group: row.group_name,
    description: row.description,
    parameters: JSON.parse(row.parameters_json),
    enabled: Boolean(row.enabled),
    builtin: Boolean(row.builtin),
    mock: row.mock_json ? JSON.parse(row.mock_json) : null,
  };
}

export function listToolRows() {
  return getDb().prepare(`
    SELECT name, group_name, description, parameters_json, enabled, builtin, mock_json
    FROM tool_definitions
    ORDER BY builtin DESC, group_name, name
  `).all().map(mapTool);
}

export function getToolRow(name) {
  const row = getDb().prepare(`
    SELECT name, group_name, description, parameters_json, enabled, builtin, mock_json
    FROM tool_definitions WHERE name = ?
  `).get(name);
  return row ? mapTool(row) : null;
}

export function insertBuiltinTool({ name, group, description, parameters }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO tool_definitions
      (name, group_name, description, parameters_json, enabled, builtin, mock_json)
    VALUES (?, ?, ?, ?, 1, 1, NULL)
  `).run(name, group, description, JSON.stringify(parameters));
}

export function insertCustomTool({ name, group, description, parameters, enabled, mock }) {
  getDb().prepare(`
    INSERT INTO tool_definitions
      (name, group_name, description, parameters_json, enabled, builtin, mock_json)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(name, group, description, JSON.stringify(parameters), enabled ? 1 : 0, JSON.stringify(mock));
}

export function updateToolRow(name, { description, enabled, parameters, mock }) {
  const current = getToolRow(name);
  if (!current) return false;
  getDb().prepare(`
    UPDATE tool_definitions
    SET description = ?, enabled = ?, parameters_json = ?, mock_json = ?
    WHERE name = ?
  `).run(
    description ?? current.description,
    enabled == null ? (current.enabled ? 1 : 0) : (enabled ? 1 : 0),
    JSON.stringify(parameters ?? current.parameters),
    current.builtin ? null : JSON.stringify(mock === undefined ? current.mock : mock),
    name,
  );
  return true;
}

export function deleteToolRow(name) {
  const result = getDb().prepare("DELETE FROM tool_definitions WHERE name = ? AND builtin = 0").run(name);
  return result.changes > 0;
}

function mapMcpConnection(row) {
  if (!row) return null;
  return {
    url: row.url,
    authToken: row.auth_token || "",
    serverName: row.server_name || "",
    protocolVersion: row.protocol_version || "",
    connected: Boolean(row.connected),
    error: row.last_error || "",
    updatedAt: row.updated_at,
  };
}

export function readMcpConnection() {
  const row = getDb().prepare(`
    SELECT url, auth_token, server_name, protocol_version, connected, last_error, updated_at
    FROM mcp_connection WHERE id = 1
  `).get();
  return mapMcpConnection(row);
}

export function saveMcpConnection({ url, authToken, serverName, protocolVersion, connected, error }) {
  getDb().prepare(`
    INSERT INTO mcp_connection
      (id, url, auth_token, server_name, protocol_version, connected, last_error, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      auth_token = excluded.auth_token,
      server_name = excluded.server_name,
      protocol_version = excluded.protocol_version,
      connected = excluded.connected,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(
    url,
    authToken ? authToken : null,
    serverName || "",
    protocolVersion || "",
    connected ? 1 : 0,
    error || "",
    new Date().toISOString(),
  );
}

function mapMcpTool(row) {
  return {
    name: row.name,
    alias: row.alias,
    description: row.description,
    parameters: JSON.parse(row.parameters_json),
    enabled: Boolean(row.enabled),
  };
}

export function listMcpToolRows() {
  return getDb().prepare(`
    SELECT name, alias, description, parameters_json, enabled
    FROM mcp_tools
    ORDER BY name
  `).all().map(mapMcpTool);
}

export function replaceMcpTools(tools) {
  const previous = new Map(listMcpToolRows().map((tool) => [tool.name, tool.enabled]));
  const database = getDb();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM mcp_tools").run();
    const insert = database.prepare(`
      INSERT INTO mcp_tools (name, alias, description, parameters_json, enabled)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const tool of tools) {
      const enabled = previous.has(tool.name) ? previous.get(tool.name) : true;
      insert.run(tool.name, tool.alias, tool.description, JSON.stringify(tool.parameters), enabled ? 1 : 0);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function setMcpToolEnabledRow(name, enabled) {
  const result = getDb().prepare(`
    UPDATE mcp_tools SET enabled = ? WHERE name = ? OR alias = ?
  `).run(enabled ? 1 : 0, name, name);
  return result.changes > 0;
}

export function clearMcpTools() {
  getDb().prepare("DELETE FROM mcp_tools").run();
}
