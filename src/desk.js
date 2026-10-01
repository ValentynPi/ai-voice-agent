import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { DEFAULT_AGENT_ID, VOICE_CHOICES } from "./defaults.js";
import { mirrorBrowserCall } from "./twilio/store.js";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function newId(prefix) {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function cleanBlock(value, max) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanVoice(value) {
  const voice = cleanBlock(value, 32).toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(voice)) throw httpError(400, "Voice id is not valid");
  return voice;
}

function cleanLanguage(value) {
  const language = cleanBlock(value, 12).toLowerCase();
  if (language !== "en" && language !== "es" && language !== "multi") {
    throw httpError(400, "Language must be en, es, or multi");
  }
  return language;
}

function cleanTools(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw httpError(400, "enabledTools must be a list or null");
  const names = [];
  for (const item of value.slice(0, 80)) {
    const name = String(item || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function cleanKnowledgeIds(value) {
  if (!Array.isArray(value)) throw httpError(400, "knowledgeIds must be a list");
  const ids = [];
  for (const item of value.slice(0, 40)) {
    const id = String(item || "").trim();
    if (!/^kb_[a-z0-9_]+$/i.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function cleanUrl(value) {
  const text = cleanBlock(value, 500);
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw httpError(400, "URL must be an http or https address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "URL must be an http or https address");
  }
  return url.toString().slice(0, 500);
}

function parseTools(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function knowledgeFor(agentId, withBody) {
  const sql = withBody
    ? `SELECT k.id, k.title, k.body, k.source_url AS sourceUrl
       FROM knowledge_bases k
       JOIN agent_knowledge ak ON ak.knowledge_id = k.id
       WHERE ak.agent_id = ?
       ORDER BY k.title`
    : `SELECT k.id, k.title, k.source_url AS sourceUrl
       FROM knowledge_bases k
       JOIN agent_knowledge ak ON ak.knowledge_id = k.id
       WHERE ak.agent_id = ?
       ORDER BY k.title`;
  return getDb().prepare(sql).all(agentId).map((row) => ({
    id: row.id,
    title: row.title,
    ...(withBody ? { body: row.body } : {}),
    sourceUrl: row.sourceUrl || "",
  }));
}

function mapAgent(row, knowledge) {
  const notes = knowledge || [];
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    systemPrompt: row.system_prompt,
    greetingEn: row.greeting_en || "",
    greetingEs: row.greeting_es || "",
    voice: row.voice || "marin",
    language: row.language || "multi",
    modelNotes: row.model_notes || "",
    enabledTools: parseTools(row.enabled_tools_json),
    knowledge: notes,
    knowledgeIds: notes.map((item) => item.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const AGENT_COLUMNS = `
  id, name, description, system_prompt, greeting_en, greeting_es, voice, language,
  model_notes, enabled_tools_json, created_at, updated_at
`;

export function listAgents() {
  const rows = getDb().prepare(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY updated_at DESC, name`).all();
  return rows.map((row) => mapAgent(row, knowledgeFor(row.id, false)));
}

export function getAgent(id) {
  const row = getDb().prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(id);
  if (!row) return null;
  return mapAgent(row, knowledgeFor(row.id, true));
}

export function requireAgent(id) {
  const agent = getAgent(id);
  if (!agent) throw httpError(404, "Agent not found");
  return agent;
}

export function getDefaultAgent() {
  return getAgent(DEFAULT_AGENT_ID) || listAgents()[0] || null;
}

export function voiceChoices() {
  return VOICE_CHOICES;
}

function agentInput(input, { requirePrompt = true } = {}) {
  const name = cleanBlock(input.name, 80);
  if (!name) throw httpError(400, "Name is required");
  const systemPrompt = cleanBlock(input.systemPrompt, 8000);
  if (requirePrompt && !systemPrompt) throw httpError(400, "System prompt is required");
  return {
    name,
    description: cleanBlock(input.description, 400),
    systemPrompt,
    greetingEn: cleanBlock(input.greetingEn, 1000),
    greetingEs: cleanBlock(input.greetingEs, 1000),
    voice: cleanVoice(input.voice || "marin"),
    language: cleanLanguage(input.language || "multi"),
    modelNotes: cleanBlock(input.modelNotes, 500),
  };
}

function setKnowledge(database, agentId, ids) {
  database.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(agentId);
  const insert = database.prepare("INSERT INTO agent_knowledge (agent_id, knowledge_id) VALUES (?, ?)");
  const known = new Set(database.prepare("SELECT id FROM knowledge_bases").all().map((row) => row.id));
  for (const id of ids) {
    if (known.has(id)) insert.run(agentId, id);
  }
}

export function createAgent(input = {}) {
  const fields = agentInput(input);
  const id = newId("agt");
  const now = new Date().toISOString();
  const tools = Object.prototype.hasOwnProperty.call(input, "enabledTools") ? cleanTools(input.enabledTools) : null;
  const knowledgeIds = Object.prototype.hasOwnProperty.call(input, "knowledgeIds") ? cleanKnowledgeIds(input.knowledgeIds) : [];
  const database = getDb();
  database.exec("BEGIN");
  try {
    database.prepare(`
      INSERT INTO agents (
        id, name, description, system_prompt, greeting_en, greeting_es,
        voice, language, model_notes, enabled_tools_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fields.name,
      fields.description,
      fields.systemPrompt,
      fields.greetingEn,
      fields.greetingEs,
      fields.voice,
      fields.language,
      fields.modelNotes,
      tools == null ? null : JSON.stringify(tools),
      now,
      now,
    );
    setKnowledge(database, id, knowledgeIds);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return requireAgent(id);
}

export function updateAgent(id, input = {}) {
  const current = requireAgent(id);
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const next = {
    name: has("name") ? cleanBlock(input.name, 80) : current.name,
    description: has("description") ? cleanBlock(input.description, 400) : current.description,
    systemPrompt: has("systemPrompt") ? cleanBlock(input.systemPrompt, 8000) : current.systemPrompt,
    greetingEn: has("greetingEn") ? cleanBlock(input.greetingEn, 1000) : current.greetingEn,
    greetingEs: has("greetingEs") ? cleanBlock(input.greetingEs, 1000) : current.greetingEs,
    voice: has("voice") ? cleanVoice(input.voice) : current.voice,
    language: has("language") ? cleanLanguage(input.language) : current.language,
    modelNotes: has("modelNotes") ? cleanBlock(input.modelNotes, 500) : current.modelNotes,
    enabledTools: has("enabledTools") ? cleanTools(input.enabledTools) : current.enabledTools,
  };
  if (!next.name) throw httpError(400, "Name is required");
  if (!next.systemPrompt) throw httpError(400, "System prompt is required");
  const knowledgeIds = has("knowledgeIds") ? cleanKnowledgeIds(input.knowledgeIds) : current.knowledgeIds;
  const database = getDb();
  database.exec("BEGIN");
  try {
    database.prepare(`
      UPDATE agents SET
        name = ?, description = ?, system_prompt = ?, greeting_en = ?, greeting_es = ?,
        voice = ?, language = ?, model_notes = ?, enabled_tools_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.description,
      next.systemPrompt,
      next.greetingEn,
      next.greetingEs,
      next.voice,
      next.language,
      next.modelNotes,
      next.enabledTools == null ? null : JSON.stringify(next.enabledTools),
      new Date().toISOString(),
      id,
    );
    if (has("knowledgeIds")) setKnowledge(database, id, knowledgeIds);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return requireAgent(id);
}

export function duplicateAgent(id) {
  const current = requireAgent(id);
  const name = `Copy of ${current.name}`.slice(0, 80);
  return createAgent({
    name,
    description: current.description,
    systemPrompt: current.systemPrompt,
    greetingEn: current.greetingEn,
    greetingEs: current.greetingEs,
    voice: current.voice,
    language: current.language,
    modelNotes: current.modelNotes,
    enabledTools: current.enabledTools,
    knowledgeIds: current.knowledgeIds,
  });
}

export function deleteAgent(id) {
  const current = requireAgent(id);
  const database = getDb();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(current.id);
    database.prepare("DELETE FROM agents WHERE id = ?").run(current.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, id: current.id };
}

function mapKnowledge(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    sourceUrl: row.source_url || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agents: getDb().prepare(`
      SELECT a.id, a.name
      FROM agents a
      JOIN agent_knowledge ak ON ak.agent_id = a.id
      WHERE ak.knowledge_id = ?
      ORDER BY a.name
    `).all(row.id),
  };
}

export function listKnowledge() {
  return getDb().prepare(`
    SELECT id, title, body, source_url, created_at, updated_at
    FROM knowledge_bases
    ORDER BY updated_at DESC, title
  `).all().map(mapKnowledge);
}

export function getKnowledge(id) {
  const row = getDb().prepare(`
    SELECT id, title, body, source_url, created_at, updated_at
    FROM knowledge_bases WHERE id = ?
  `).get(id);
  return row ? mapKnowledge(row) : null;
}

function knowledgeInput(input) {
  const title = cleanBlock(input.title, 120);
  if (!title) throw httpError(400, "Title is required");
  const body = cleanBlock(input.body, 20000);
  if (!body) throw httpError(400, "Text is required");
  return { title, body, sourceUrl: cleanUrl(input.sourceUrl) };
}

export function createKnowledge(input = {}) {
  const fields = knowledgeInput(input);
  const id = newId("kb");
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO knowledge_bases (id, title, body, source_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, fields.title, fields.body, fields.sourceUrl || null, now, now);
  return getKnowledge(id);
}

export function updateKnowledge(id, input = {}) {
  const current = getKnowledge(id);
  if (!current) throw httpError(404, "Knowledge entry not found");
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const fields = knowledgeInput({
    title: has("title") ? input.title : current.title,
    body: has("body") ? input.body : current.body,
    sourceUrl: has("sourceUrl") ? input.sourceUrl : current.sourceUrl,
  });
  getDb().prepare(`
    UPDATE knowledge_bases
    SET title = ?, body = ?, source_url = ?, updated_at = ?
    WHERE id = ?
  `).run(fields.title, fields.body, fields.sourceUrl || null, new Date().toISOString(), id);
  return getKnowledge(id);
}

export function deleteKnowledge(id) {
  const current = getKnowledge(id);
  if (!current) throw httpError(404, "Knowledge entry not found");
  const database = getDb();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM agent_knowledge WHERE knowledge_id = ?").run(id);
    database.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, id };
}

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

export function summarizeTranscript(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const users = list.filter((message) => message.role === "user" && message.text);
  const agents = list.filter((message) => message.role === "assistant" && message.text);
  if (!users.length && !agents.length) return "Web test call ended before anyone spoke.";
  const ask = users[0] ? `Caller: ${clip(users[0].text, 180)}` : "Caller did not speak.";
  const answer = agents.at(-1) ? `Agent: ${clip(agents.at(-1).text, 220)}` : "No agent reply was captured.";
  const extra = users.length > 1 ? ` ${users.length} caller turns.` : "";
  return `${ask} ${answer}${extra}`;
}

export function saveCallRecord(call) {
  if (!call?.id || call.source === "seed" || call.status === "active") return;
  const transcript = (call.messages || []).slice(-200).map((message) => ({
    role: message.role,
    text: message.text,
    at: message.at,
    tools: message.tools || [],
  }));
  const endedAt = call.endedAt || new Date().toISOString();
  const startedMs = Date.parse(call.startedAt);
  const endedMs = Date.parse(endedAt);
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0;
  const status = call.endReason === "failed" || call.endReason === "error" ? "failed" : "completed";
  getDb().prepare(`
    INSERT INTO call_records (
      id, agent_id, agent_name, source, status, started_at, ended_at, duration_ms,
      transcript_json, summary, voice, language, end_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_id = excluded.agent_id,
      agent_name = excluded.agent_name,
      source = excluded.source,
      status = excluded.status,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      duration_ms = excluded.duration_ms,
      transcript_json = excluded.transcript_json,
      summary = excluded.summary,
      voice = excluded.voice,
      language = excluded.language,
      end_reason = excluded.end_reason
  `).run(
    call.id,
    call.agentId || null,
    call.agentName || null,
    call.source || "browser",
    status,
    call.startedAt,
    endedAt,
    durationMs,
    JSON.stringify(transcript),
    summarizeTranscript(transcript),
    call.voice || null,
    call.lang || null,
    call.endReason || null,
  );
  mirrorBrowserCall(call, { status, durationMs, endedAt });
}

function mapRecord(row) {
  let transcript = [];
  try {
    const parsed = JSON.parse(row.transcript_json || "[]");
    transcript = Array.isArray(parsed) ? parsed : [];
  } catch {
    transcript = [];
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    source: row.source,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms || 0,
    transcript,
    summary: row.summary || "",
    voice: row.voice,
    language: row.language,
    endReason: row.end_reason,
  };
}

function liveRecord(call) {
  const startedMs = Date.parse(call.startedAt);
  return {
    id: call.id,
    agentId: call.agentId || null,
    agentName: call.agentName || null,
    source: call.source || "browser",
    status: "in_progress",
    startedAt: call.startedAt,
    endedAt: null,
    durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
    transcript: call.messages || [],
    summary: "",
    voice: call.voice || null,
    language: call.lang || null,
    endReason: null,
  };
}

export function listHistory(activeCalls = []) {
  const stored = getDb().prepare(`
    SELECT * FROM call_records
    ORDER BY started_at DESC
    LIMIT 200
  `).all().map(mapRecord);
  const seen = new Set(stored.map((row) => row.id));
  const live = [];
  for (const call of activeCalls) {
    if (!call || seen.has(call.id) || call.source === "seed" || call.status !== "active") continue;
    live.push(liveRecord(call));
  }
  return [...live, ...stored];
}

export function getHistoryCall(id, activeCalls = []) {
  const row = getDb().prepare("SELECT * FROM call_records WHERE id = ?").get(id);
  if (row) return mapRecord(row);
  const live = (activeCalls || []).find((call) => call?.id === id && call.status === "active" && call.source !== "seed");
  return live ? liveRecord(live) : null;
}

export function callAnalytics() {
  const rows = getDb().prepare("SELECT status, started_at, duration_ms FROM call_records").all();
  const total = rows.length;
  const completed = rows.filter((row) => row.status === "completed").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const avgDurationMs = total
    ? Math.round(rows.reduce((sum, row) => sum + (row.duration_ms || 0), 0) / total)
    : null;
  const recentVolume = [];
  const today = new Date();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    const key = day.toISOString().slice(0, 10);
    recentVolume.push({
      date: key,
      count: rows.filter((row) => String(row.started_at || "").startsWith(key)).length,
    });
  }
  return {
    callCount: total,
    completed,
    failed,
    avgDurationMs,
    completionRate: total ? completed / total : null,
    recentVolume,
  };
}
