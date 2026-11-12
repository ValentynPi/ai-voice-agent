/**
 * The cascade "brain": OpenAI Chat Completions, streamed, with the agent's MCP
 * tools as functions. Text deltas go to TTS sentence by sentence.
 */
import { classifyOpenAiFailure } from "../realtime.js";
import { CASCADE_LLM_FALLBACKS, cascadeProviders } from "./config.js";

let resolvedModel = null;
let reasoningRejected = new Set();
export function resetCascadeModel() {
  resolvedModel = null;
  reasoningRejected = new Set();
}

/** Realtime tool spec ({type,name,description,parameters}) -> Chat Completions tool. */
export function chatTool(spec) {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description || "",
      parameters: spec.parameters && typeof spec.parameters === "object" ? spec.parameters : { type: "object", properties: {} },
    },
  };
}

function modelList() {
  const first = resolvedModel || cascadeProviders().llm;
  return [...new Set([first, ...CASCADE_LLM_FALLBACKS])];
}

/** GPT-6 / GPT-5 family: function calling over Chat Completions needs reasoning_effort "none". */
function wantsReasoningNone(model) {
  return /^gpt-(?:5|6)/.test(model) && !reasoningRejected.has(model);
}

export function chatBody(model, { messages, tools, toolChoice, maxTokens = 300, cacheKey = "" }) {
  const body = { model, messages, stream: true, max_completion_tokens: maxTokens };
  if (wantsReasoningNone(model)) body.reasoning_effort = "none";
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
    body.parallel_tool_calls = true;
  }
  if (cacheKey) body.prompt_cache_key = cacheKey;
  return body;
}

/** Parse an SSE byte stream into JSON chunks. */
export async function* sseJson(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch { /* partial or junk line */ }
    }
  }
}

/**
 * Yields { type: "text", delta } and finally { type: "tool_calls", calls } when
 * the model asked for tools, then { type: "done", model }.
 */
export async function* streamChat({ messages, tools = [], toolChoice = "auto", signal, maxTokens = 300, cacheKey = "", fetchImpl = fetch, apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!apiKey) {
    const error = new Error("The cascade brain needs OPENAI_API_KEY");
    error.code = "openai_key_missing";
    throw error;
  }
  let lastError = null;
  for (const model of modelList()) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": "voice-desk-cascade" },
        body: JSON.stringify(chatBody(model, { messages, tools, toolChoice, maxTokens, cacheKey })),
        signal,
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const account = classifyOpenAiFailure(response.status, raw);
        if (account) throw account;
        if (response.status === 400 && /reasoning/i.test(raw) && wantsReasoningNone(model)) {
          reasoningRejected.add(model);
          continue;
        }
        lastError = new Error(`OpenAI rejected the cascade request (HTTP ${response.status})`);
        lastError.code = "openai_error";
        if ((response.status === 400 || response.status === 404) && /model/i.test(raw)) break; // next model
        throw lastError;
      }
      resolvedModel = model;
      const calls = new Map();
      for await (const chunk of sseJson(response.body)) {
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) yield { type: "text", delta: delta.content };
        for (const call of delta.tool_calls || []) {
          const slot = calls.get(call.index ?? 0) || { id: "", name: "", arguments: "" };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.arguments += call.function.arguments;
          calls.set(call.index ?? 0, slot);
        }
      }
      if (calls.size) yield { type: "tool_calls", calls: [...calls.values()].filter((c) => c.name) };
      yield { type: "done", model };
      return;
    }
  }
  throw lastError || Object.assign(new Error("No OpenAI text model accepted the cascade request"), { code: "openai_error" });
}

/**
 * Sentence chunker for streamed text: returns the finished sentences in
 * `buffer` and the unfinished rest. The first chunk may end at a comma once
 * it is long enough, so the first audio starts sooner.
 */
export function takeSentences(buffer, { first = false } = {}) {
  const out = [];
  let rest = String(buffer || "");
  for (;;) {
    const match = rest.match(/^([\s\S]*?[.!?…;:]+["»”')\]]*)(\s+)/u) || rest.match(/^([\s\S]*?)\n+/);
    if (match && match[1].trim()) {
      out.push(match[1].trim());
      rest = rest.slice(match[0].length);
      continue;
    }
    if (first && !out.length && rest.length >= 60) {
      const comma = rest.slice(24).search(/[,—–]\s/u);
      if (comma >= 0) {
        const cut = 24 + comma + 1;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trimStart();
        continue;
      }
    }
    break;
  }
  return { sentences: out, rest };
}
