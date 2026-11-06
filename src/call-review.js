import { getAgent, setCallReview, updateAgent } from "./desk.js";
import { noteChatModel } from "./models.js";
import { classifyCallerTranscript } from "../public/js/caller-language.js";
import { listToolCallsForCall } from "./store.js";

const MODEL_NOTES_CAP = 1800;
const LESSON_MAX = 140;
const MAX_LESSONS = 8;
const LESSONS_HEADER = "Lessons:";

/** @typedef {{ field: "modelNotes" | "systemPrompt", text: string }} Lesson */

export function clipLesson(text, max = LESSON_MAX) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

/**
 * Lessons that must never reach the prompt: ones that pin a fixed language
 * ("answer in Russian when they speak Russian" turned misheard Ukrainian into
 * Russian) or widen the job beyond the Bot task.
 */
export function isHarmfulLesson(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return true;
  if (/\b(english|russian|spanish|ukrainian|hebrew|french|german)\b/.test(t)) return true;
  if (/\b(anything|whatever|any task|general (help|tasks?|assistant))\b/.test(t) && !/\b(decline|never|don't|do not|not)\b/.test(t)) return true;
  return false;
}

export function parseLessonLines(notes) {
  const raw = String(notes || "");
  const idx = raw.indexOf(LESSONS_HEADER);
  if (idx < 0) return { preamble: raw.trim(), lessons: [] };
  const preamble = raw.slice(0, idx).trim();
  const body = raw.slice(idx + LESSONS_HEADER.length);
  const lessons = body
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  return { preamble, lessons };
}

export function formatModelNotes(preamble, lessons, cap = MODEL_NOTES_CAP) {
  const kept = [...lessons].filter(Boolean).slice(-MAX_LESSONS);
  const lessonBlock = kept.length
    ? `${LESSONS_HEADER}\n${kept.map((line) => `- ${clipLesson(line)}`).join("\n")}`
    : "";
  let combined = [preamble, lessonBlock].filter(Boolean).join("\n\n").trim();
  while (combined.length > cap && kept.length > 1) {
    kept.shift();
    const nextBlock = `${LESSONS_HEADER}\n${kept.map((line) => `- ${clipLesson(line)}`).join("\n")}`;
    combined = [preamble, nextBlock].filter(Boolean).join("\n\n").trim();
  }
  if (combined.length > cap) {
    const room = Math.max(40, cap - (lessonBlock ? lessonBlock.length + 2 : 0));
    const trimmedPreamble = preamble.slice(0, room).trim();
    combined = [trimmedPreamble, lessonBlock].filter(Boolean).join("\n\n").trim().slice(0, cap);
  }
  return combined;
}

export function mergeLessonsIntoNotes(existingNotes, newLessons) {
  const { preamble, lessons } = parseLessonLines(existingNotes);
  const merged = [...lessons];
  for (const raw of newLessons || []) {
    const text = clipLesson(raw);
    if (!text || isHarmfulLesson(text)) continue;
    const key = text.toLowerCase();
    if (merged.some((item) => item.toLowerCase() === key)) continue;
    // Drop near-duplicates that share a long prefix.
    const near = merged.findIndex((item) => {
      const a = item.toLowerCase();
      return a.startsWith(key.slice(0, 40)) || key.startsWith(a.slice(0, 40));
    });
    if (near >= 0) merged.splice(near, 1, text);
    else merged.push(text);
  }
  return formatModelNotes(preamble, merged);
}

function transcriptLines(messages) {
  return (messages || [])
    .slice(-40)
    .map((message) => {
      const who = message.role === "user" ? "Caller" : "Agent";
      const tools = Array.isArray(message.tools) && message.tools.length
        ? ` [tools: ${message.tools.map((tool) => {
          const name = tool.name || "tool";
          if (tool.ok === false || tool.decision === "deny") return `${name}:fail`;
          return `${name}:ok`;
        }).join(", ")}]`
        : "";
      return `${who}: ${String(message.text || "").slice(0, 400)}${tools}`;
    })
    .filter((line) => !/:\s*$/.test(line));
}

function toolSummary(callId) {
  return listToolCallsForCall(callId).slice(-20).map((tool) => ({
    name: tool.name,
    ok: tool.ok,
    decision: tool.decision,
    error: tool.ok ? null : String(tool.result?.error || tool.result?.message || "").slice(0, 120),
  }));
}

function heuristicLessons(call, tools) {
  /** @type {string[]} */
  const lessons = [];
  const messages = call.messages || [];
  const users = messages.filter((message) => message.role === "user" && String(message.text || "").trim());
  const agents = messages.filter((message) => message.role === "assistant" && String(message.text || "").trim());
  const failedTools = tools.filter((tool) => tool.ok === false || tool.decision === "deny");

  if (users.length && !agents.length) {
    lessons.push("Always answer after the caller finishes speaking; never leave dead air or hang without a reply.");
  }
  if (failedTools.length) {
    lessons.push("If a lookup fails or times out, say so in one short sentence in the caller's language; never invent results.");
  }
  if (call.endReason === "failed" || call.endReason === "error") {
    lessons.push("Stay on the call and answer usefully; recover briefly from errors instead of going silent.");
  }

  const joinedUser = users.map((message) => message.text).join(" ").toLowerCase();
  const weatherAsk = /\b(weather|clima|tiempo|погод|מזג|forecast|температур)/i.test(joinedUser);
  const refused = agents.some((message) => /cannot|can't|unable|no puedo|не можу|не могу|לא יכול/i.test(message.text || ""));
  const usedWeather = tools.some((tool) => /weather|place|forecast|geocode/i.test(tool.name || ""));
  if (weatherAsk && refused && !usedWeather) {
    lessons.push("For a clear weather ask about a city, call the place weather tool and speak the real result; do not refuse.");
  }
  if (weatherAsk && tools.some((tool) => /airport|aerodrome/i.test(JSON.stringify(tool.error || "")))) {
    lessons.push("If the weather tool returns the named city's airport, treat it as that city and speak the conditions.");
  }

  return lessons.slice(0, 2);
}

function reviewSystemPrompt(agent) {
  return [
    "You review one finished phone-agent call and propose durable behavior lessons.",
    "Return ONLY compact JSON with keys: ok (boolean), issues (string[]), lessons (string[]), historyNote (string).",
    "ok=true means the call was fine enough; then lessons must be [] and historyNote like \"Reviewed · no change\".",
    "ok=false when there were clear failures: wrong language, silence/no answer, tool failure spoken poorly,",
    "refused a valid weather ask, inventing facts, off-mission ChatGPT behavior, long dead air, misunderstanding a place/airport, etc.",
    "Each lesson must be one short imperative about behavior (language, when to call tools, airport geocode handling, don't go silent).",
    "NEVER invent business facts, weather numbers, addresses, hours, prices, or customer data into lessons.",
    "Do not rewrite the agent's mission. Prefer at most 2 lessons. Each lesson <= 140 chars.",
    "historyNote when learning: \"Reviewed · N lesson(s)\" with the real count.",
    `Agent Bot task (do not wipe; only learn behavior):\n${String(agent.systemPrompt || "").slice(0, 800)}`,
    `Existing Model notes:\n${String(agent.modelNotes || "").slice(0, 600) || "(none)"}`,
  ].join("\n");
}

async function askModel(agent, call, tools) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  // Keep unit/integration tests deterministic unless explicitly opted in.
  if (process.env.NODE_ENV === "test" && process.env.CALL_REVIEW_ALLOW_MODEL !== "1") return null;
  const lines = transcriptLines(call.messages);
  if (!lines.length && !tools.length && call.endReason !== "failed" && call.endReason !== "error") {
    return { ok: true, issues: [], lessons: [], historyNote: "Reviewed · no change" };
  }
  const userPayload = {
    endReason: call.endReason || null,
    durationHintSec: call.startedAt && call.endedAt
      ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000))
      : null,
    transcript: lines,
    tools,
  };
  // A cheap model is plenty for "any lesson in this transcript?". It used to be
  // the chat model (gpt-5.1) on every ended call.
  const candidates = reviewCandidates();
  let lastError;
  for (const model of candidates) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: reviewSystemPrompt(agent) },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`review HTTP ${response.status}: ${detail.slice(0, 160)}`);
        error.modelRejected = (response.status === 400 || response.status === 404) && /model/i.test(detail);
        throw error;
      }
      const payload = await response.json();
      const raw = payload.choices?.[0]?.message?.content || "{}";
      noteChatModel(model);
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (!error.modelRejected) break;
    }
  }
  if (lastError) console.error("Post-call review model failed:", lastError.message || lastError);
  return null;
}

function normalizeReview(raw, fallbackLessons) {
  if (!raw || typeof raw !== "object") {
    const lessons = fallbackLessons.slice(0, 2).map((text) => clipLesson(text)).filter(Boolean);
    return {
      ok: lessons.length === 0,
      lessons,
      historyNote: lessons.length
        ? `Reviewed · ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`
        : "Reviewed · no change",
    };
  }
  const ok = raw.ok !== false;
  let lessons = Array.isArray(raw.lessons)
    ? raw.lessons.map((item) => clipLesson(typeof item === "string" ? item : item?.text)).filter(Boolean)
    : [];
  if (ok) lessons = [];
  if (!ok && !lessons.length) lessons = fallbackLessons.slice(0, 2).map((text) => clipLesson(text)).filter(Boolean);
  lessons = lessons.slice(0, 2);
  const historyNote = lessons.length
    ? (String(raw.historyNote || "").trim() || `Reviewed · ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`)
    : "Reviewed · no change";
  return { ok: lessons.length === 0, lessons, historyNote: historyNote.slice(0, 80) };
}

/**
 * After a call ends: review transcript/tools, optionally append Model notes lessons.
 * Fire-and-forget safe; never throws to the hangup path.
 */
export const DEFAULT_REVIEW_MODEL = "gpt-4o-mini";
export function reviewCandidates() {
  const picked = String(process.env.OPENAI_REVIEW_MODEL || DEFAULT_REVIEW_MODEL).trim();
  return [...new Set([picked, "gpt-4.1-mini"])];
}

/** Caller turns that are real speech (not noise, filler, or a transcription hallucination). */
export function realCallerTurns(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === "user" && classifyCallerTranscript(String(message.text || "")) === "speech");
}

export async function reviewEndedCall(call) {
  if (!call?.id || call.source === "seed" || call.status === "active") return null;
  if (!call.agentId) {
    setCallReview(call.id, { reviewNote: "Reviewed · no agent", reviewLessons: 0 });
    return { skipped: true, reason: "no-agent" };
  }

  const agent = getAgent(call.agentId);
  if (!agent) {
    setCallReview(call.id, { reviewNote: "Reviewed · agent missing", reviewLessons: 0 });
    return { skipped: true, reason: "missing-agent" };
  }

  const tools = toolSummary(call.id);
  const fallback = heuristicLessons(call, tools);
  const lines = transcriptLines(call.messages);

  if (!lines.length && !fallback.length) {
    setCallReview(call.id, { reviewNote: "Reviewed · no change", reviewLessons: 0 });
    console.info(`call-review ${call.id}: no change (empty transcript)`);
    return { ok: true, lessons: [], historyNote: "Reviewed · no change" };
  }

  // No real caller turn: nothing for a model to learn from. Heuristics only, no API call.
  const modelReview = realCallerTurns(call.messages).length ? await askModel(agent, call, tools) : null;
  if (!modelReview) console.info(`call-review ${call.id}: ${realCallerTurns(call.messages).length ? "model unavailable" : "no real caller turns"}; heuristics only`);
  const verdict = normalizeReview(modelReview, fallback);

  if (!verdict.lessons.length) {
    setCallReview(call.id, { reviewNote: verdict.historyNote, reviewLessons: 0 });
    console.info(`call-review ${call.id}: no change`);
    return verdict;
  }

  const nextNotes = mergeLessonsIntoNotes(agent.modelNotes, verdict.lessons);
  if (nextNotes !== (agent.modelNotes || "").trim()) {
    updateAgent(agent.id, { modelNotes: nextNotes }, agent.accountId);
  }

  setCallReview(call.id, {
    reviewNote: verdict.historyNote,
    reviewLessons: verdict.lessons.length,
  });
  console.info(`call-review ${call.id}: ${verdict.lessons.length} lesson(s) → ${agent.id}`);
  return { ...verdict, modelNotes: nextNotes };
}
