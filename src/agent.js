import { composeToolReply, detectLang as detect, forSpeech, refusal } from "./format.js";
import { chatCandidates, noteChatModel } from "./models.js";
import { receptionistInstructions } from "./realtime.js";
import { screenInput, sanitizeText } from "./security.js";
import { appendMessage, getCall, recordSecurity, touchCall } from "./store.js";
import { listCustomers } from "./db.js";
import { executeTool, isToolEnabled, openaiToolSpecs } from "./tools/registry.js";

export function detectLang(text) {
  return detect(text);
}

function norm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function add(planned, name, args) {
  if (!isToolEnabled(name)) return;
  if (planned.length >= 3) return;
  if (planned.some((item) => item.name === name)) return;
  planned.push({ name, args });
}

export function planTools(text) {
  const n = norm(text);
  const planned = [];
  const forecast = /\b(forecast|this week|next few days|tomorrow|prevision|pronostico|semana|manana|proximos dias)\b/.test(n);
  const weather = forecast
    || /\b(weather|temperature|rain|raining|sunny|windy|humidity|clima|lluvia|temperatura|viento|humedad|prevision|pronostico)\b/.test(n)
    || /\b(que tiempo|el tiempo|tiempo hace|hows the weather|how is the weather)\b/.test(n);

  if (forecast) add(planned, "get_forecast", { days: 4 });
  else if (weather) add(planned, "get_weather", {});

  const customer = matchCustomer(n);
  const orderPrefixed = n.match(/\b(?:order|pedido|ord)\s*#?\s*(\d{3,5})\b/);
  const knownOrder = n.match(/\b(1042|1048|1033)\b/);
  const orderNumber = orderPrefixed?.[1] || knownOrder?.[1];
  const mentionsOrder = /\b(order|orders|pedido|pedidos)\b/.test(n);

  if (orderNumber) add(planned, "get_order", { id: orderNumber });
  else if (mentionsOrder && customer) add(planned, "get_order", { customer });
  else if (mentionsOrder) add(planned, "list_orders", {});

  const mentionsAppointment = /\b(appointment|appointments|agenda|schedule|cita|citas|reserva|reservas|booking|bookings)\b/.test(n);
  if (customer && !planned.some((item) => item.name === "get_order" && item.args.customer === customer)) {
    add(planned, "lookup_customer", { name: customer });
  } else if (mentionsAppointment && !customer) {
    add(planned, "list_appointments", {});
  }

  if (/\b(services|service menu|prices|price list|how much|cost|tratamiento|tratamientos|servicios|precios|cuesta|tarifa)\b/.test(n)) {
    add(planned, "query_services", {});
  }
  if (/\b(stylists|stylist|staff|team|who works|peluqueros|equipo|marta|joan|nuria)\b/.test(n)) {
    add(planned, "query_staff", {});
  }
  if (/\b(opening hours|opening times|business hours|are you open|when do you open|when are you open|what time do you close|horario|horarios|a que hora|hours|abris|cerrais)\b/.test(n)) {
    add(planned, "query_hours", {});
  }
  return planned;
}

function matchCustomer(normalized) {
  const ranked = listCustomers()
    .flatMap((person) => {
      const full = norm(person.name);
      return [
        { name: person.name, key: full },
        { name: person.name, key: full.split(" ")[0] },
      ];
    })
    .sort((a, b) => b.key.length - a.key.length);
  const hit = ranked.find((person) => person.key && new RegExp(`\\b${escapeRegExp(person.key)}\\b`).test(normalized));
  return hit?.name || null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chatBody(model, messages) {
  const body = {
    model,
    messages,
    tools: openaiToolSpecs(),
    tool_choice: "auto",
  };
  if (!/^gpt-5|^o\d/i.test(model)) body.temperature = 0.4;
  return body;
}

function modelRejected(status, detail) {
  return (status === 400 || status === 404) && /model/i.test(detail);
}

async function runPlanned(callId, planned) {
  const results = [];
  for (const step of planned) {
    results.push(await executeTool({ callId, name: step.name, args: step.args }));
  }
  return results;
}

async function runOpenAIModel(model, { callId, text, lang, history }) {
  const messages = [
    { role: "system", content: receptionistInstructions(lang) },
    ...history,
    { role: "user", content: text },
  ];
  const used = [];

  try {
    for (let round = 0; round < 3; round += 1) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chatBody(model, messages)),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`OpenAI HTTP ${response.status}: ${detail.slice(0, 180)}`);
        error.modelRejected = modelRejected(response.status, detail);
        throw error;
      }
      const payload = await response.json();
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("OpenAI returned no message");
      const toolCalls = message.tool_calls || [];
      if (!toolCalls.length) {
        noteChatModel(model);
        return {
          reply: forSpeech(message.content) || composeToolReply(used, lang, text),
          tools: used,
          mode: "openai",
        };
      }

      messages.push({
        role: "assistant",
        content: message.content || "",
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const name = call.function?.name || "";
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        const outcome = await executeTool({ callId, name, args });
        used.push(outcome);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.result?.error || "denied" }),
        });
      }
    }

    noteChatModel(model);
    return {
      reply: composeToolReply(used, lang, text),
      tools: used,
      mode: "openai",
    };
  } catch (error) {
    error.partialTools = used;
    throw error;
  }
}

async function runOpenAI(input) {
  const models = chatCandidates();
  let lastError;
  for (let index = 0; index < models.length; index += 1) {
    try {
      return await runOpenAIModel(models[index], input);
    } catch (error) {
      lastError = error;
      const more = index < models.length - 1;
      if (!error.modelRejected || !more || error.partialTools?.length) throw error;
      console.error(`Chat model ${models[index]} was rejected, trying ${models[index + 1]}`);
    }
  }
  throw lastError;
}

export async function handleTurn({ callId, text, lang }) {
  const call = getCall(callId);
  if (!call || call.status !== "active") {
    const error = new Error("Call is not active");
    error.status = 409;
    throw error;
  }
  touchCall(callId);

  const clean = sanitizeText(text);
  const language = lang === "es" || lang === "en" ? lang : detect(clean);
  const screen = screenInput(clean);
  recordSecurity({
    callId,
    kind: "input",
    decision: screen.decision,
    summary: screen.summary,
    detail: screen.detail,
    reasonCode: screen.reasonCode,
    excerpt: clean,
  });

  if (!clean || screen.reasonCode === "empty") {
    const error = new Error("Message is empty");
    error.status = 400;
    throw error;
  }

  const history = call.messages.slice(-8).map((message) => ({
    role: message.role,
    content: message.text,
  }));
  appendMessage(callId, { role: "user", text: clean, tools: [] });

  if (screen.decision === "deny") {
    const reply = refusal(language);
    appendMessage(callId, { role: "assistant", text: reply, tools: [] });
    return { reply, lang: language, mode: "rules", security: publicSecurity(screen), tools: [] };
  }

  let outcome;
  if (process.env.OPENAI_API_KEY) {
    try {
      outcome = await runOpenAI({ callId, text: clean, lang: language, history });
    } catch (error) {
      console.error("OpenAI failed, using the keyword planner:", error.message);
      const tools = error.partialTools?.length
        ? error.partialTools
        : await runPlanned(callId, planTools(clean));
      outcome = {
        reply: composeToolReply(tools, language, clean),
        tools,
        mode: "rules",
        fallback: true,
      };
    }
  } else {
    const planned = planTools(clean);
    const tools = await runPlanned(callId, planned);
    outcome = {
      reply: composeToolReply(tools, language, clean),
      tools,
      mode: "rules",
    };
  }

  const reply = forSpeech(outcome.reply) || refusal(language);
  const toolSummary = (outcome.tools || []).map((tool) => ({
    name: tool.name,
    decision: tool.decision,
    ok: tool.ok,
  }));
  appendMessage(callId, { role: "assistant", text: reply, tools: toolSummary, mode: outcome.mode });
  return {
    reply,
    lang: language,
    mode: outcome.mode,
    fallback: Boolean(outcome.fallback),
    security: publicSecurity(screen),
    tools: toolSummary,
  };
}

function publicSecurity(screen) {
  return {
    decision: screen.decision,
    summary: screen.summary,
    detail: screen.detail,
    reasonCode: screen.reasonCode,
  };
}
