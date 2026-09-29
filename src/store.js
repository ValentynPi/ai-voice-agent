const MAX_EVENTS = 80;
const MAX_TOOL_CALLS = 80;

const state = {
  calls: [],
  securityEvents: [],
  toolCalls: [],
  callsToday: 0,
  seq: 0,
};

function nextId(prefix) {
  state.seq += 1;
  return `${prefix}_${state.seq}`;
}

function pushCapped(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

export function resetStore() {
  state.calls = [];
  state.securityEvents = [];
  state.toolCalls = [];
  state.callsToday = 0;
  state.seq = 0;
}

export function startCall({ source = "browser" } = {}) {
  const call = {
    id: nextId("call"),
    source,
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lastSeenAt: Date.now(),
    messages: [],
  };
  state.calls.push(call);
  state.callsToday += 1;
  return publicCall(call);
}

export function getCall(callId) {
  return state.calls.find((call) => call.id === callId) || null;
}

export function touchCall(callId) {
  const call = getCall(callId);
  if (call && call.status === "active") call.lastSeenAt = Date.now();
  return call;
}

export function endCall(callId, reason = "client") {
  const call = getCall(callId);
  if (!call) return null;
  if (call.status === "active") {
    call.status = "ended";
    call.endedAt = new Date().toISOString();
    call.endReason = reason;
  }
  return publicCall(call);
}

export function sweepCalls(maxIdleMs = 20000) {
  const now = Date.now();
  for (const call of state.calls) {
    if (call.status === "active" && now - call.lastSeenAt > maxIdleMs) {
      call.status = "ended";
      call.endedAt = new Date().toISOString();
      call.endReason = "idle";
    }
  }
}

export function appendMessage(callId, message) {
  const call = getCall(callId);
  if (!call) return null;
  const entry = {
    id: nextId("msg"),
    role: message.role,
    text: message.text,
    tools: message.tools || [],
    mode: message.mode || null,
    at: new Date().toISOString(),
  };
  call.messages.push(entry);
  call.lastSeenAt = Date.now();
  return entry;
}

export function recordSecurity(event) {
  const entry = {
    id: nextId("sec"),
    at: new Date().toISOString(),
    callId: event.callId || null,
    kind: event.kind,
    decision: event.decision,
    summary: event.summary,
    detail: event.detail,
    reasonCode: event.reasonCode || null,
    tool: event.tool || null,
    excerpt: String(event.excerpt || "").slice(0, 180),
  };
  pushCapped(state.securityEvents, entry, MAX_EVENTS);
  return entry;
}

export function recordToolCall(event) {
  const entry = {
    id: nextId("tool"),
    at: new Date().toISOString(),
    callId: event.callId || null,
    name: event.name,
    group: event.group,
    args: event.args || {},
    decision: event.decision,
    ok: Boolean(event.ok),
    result: event.result,
    durationMs: event.durationMs ?? 0,
  };
  pushCapped(state.toolCalls, entry, MAX_TOOL_CALLS);
  return entry;
}

function publicCall(call) {
  if (!call) return null;
  return {
    id: call.id,
    source: call.source,
    status: call.status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    endReason: call.endReason,
    messages: call.messages.map((message) => ({ ...message, tools: [...message.tools] })),
  };
}

export function currentConversation() {
  const active = [...state.calls].reverse().find((call) => call.status === "active");
  const call = active || state.calls[state.calls.length - 1] || null;
  return publicCall(call);
}

export function getSnapshot() {
  const activeCalls = state.calls.filter((call) => call.status === "active").length;
  return {
    status: "online",
    activeCalls,
    callsToday: state.callsToday,
    denies: state.securityEvents.filter((event) => event.decision === "deny").length,
    toolCallCount: state.toolCalls.length,
    conversation: currentConversation(),
    recentCalls: state.calls.slice(-8).map(publicCall),
    securityEvents: [...state.securityEvents].reverse(),
    toolCalls: [...state.toolCalls].reverse(),
  };
}
