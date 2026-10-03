import WebSocket, { WebSocketServer } from "ws";
import { getAgent, getDefaultAgent } from "../desk.js";
import { ensureMcp } from "../mcp/connection.js";
import { realtimeCandidates, noteRealtimeModel, voiceName } from "../models.js";
import {
  TOOL_FETCH_TIMEOUT_MS,
  completeTool,
  createResponseGate,
  failureLine,
  functionOutputEvent,
  ingestRealtimeEvent,
  noteBargeIn,
  noteCallerSpeech,
  withTimeout,
} from "../../public/js/realtime-turn.js";
import {
  buildRealtimeSession,
  greetingEvent,
  recordRealtimeUtterance,
  runRealtimeTool,
} from "../realtime.js";
import { endCall, startCall, touchCall } from "../store.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

const attachedServers = new WeakSet();

/**
 * Attach Twilio Media Streams upgrade handling to an HTTP server.
 * Safe to call once per server instance.
 */
export function attachMediaBridge(server) {
  if (!server || attachedServers.has(server)) return;
  attachedServers.add(server);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/twilio/media") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url || "/", "http://localhost");
      handleTwilioMedia(ws, url).catch((error) => {
        console.error("Media stream bridge failed:", error?.message || error);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      });
    });
  });
}

function pickAgent(agentId) {
  if (agentId) {
    const found = getAgent(agentId);
    if (found) return found;
  }
  return getDefaultAgent();
}

function sessionVariant(session, dropTurnFlags) {
  if (!dropTurnFlags) return session;
  const next = structuredClone(session);
  const detection = next.audio?.input?.turn_detection;
  if (detection) {
    delete detection.create_response;
    delete detection.interrupt_response;
    delete detection.eagerness;
  }
  return next;
}

async function openOpenAiRealtime({ lang, agent }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const error = new Error("Realtime voice needs OPENAI_API_KEY");
    error.status = 503;
    throw error;
  }
  await ensureMcp();
  const candidates = realtimeCandidates();
  let lastError = "Realtime session was rejected";
  for (const model of candidates) {
    for (const dropTurnFlags of [false, true]) {
      const session = sessionVariant(buildRealtimeSession(model, lang, agent, { telephony: true }), dropTurnFlags);
      const ws = await connectOpenAiWs(model, key);
      try {
        await waitForEvent(ws, "session.created", 15000);
        ws.send(JSON.stringify({ type: "session.update", session }));
        await waitForEvent(ws, "session.updated", 15000);
        noteRealtimeModel(model);
        return { ws, model, session, voice: String(agent?.voice || "").trim() || voiceName() };
      } catch (error) {
        lastError = error?.message || lastError;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (!dropTurnFlags && /create_response|interrupt_response|eagerness|turn_detection|unknown|additional/i.test(lastError)) {
          continue;
        }
        if (/model/i.test(lastError)) break;
      }
    }
  }
  const error = new Error(lastError || "No Realtime model accepted the session");
  error.status = 502;
  throw error;
}

function connectOpenAiWs(model, key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("OpenAI Realtime connect timed out"));
    }, 15000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForEvent(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    function onMessage(raw) {
      let event;
      try {
        event = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (event.type === "error") {
        cleanup();
        reject(new Error(event.error?.message || event.message || "Realtime error"));
        return;
      }
      if (event.type === type) {
        cleanup();
        resolve(event);
      }
    }
    function onClose() {
      cleanup();
      reject(new Error(`OpenAI socket closed before ${type}`));
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function handleTwilioMedia(twilioWs, url) {
  let streamSid = null;
  let openai = null;
  let deskCall = null;
  let closed = false;
  let greetingSent = false;
  const responseGate = createResponseGate();
  let greetingDone = false;
  const agentHint = String(url.searchParams.get("agentId") || "").trim();
  let lang = String(url.searchParams.get("lang") || "multi").trim().toLowerCase();
  if (lang !== "es" && lang !== "en" && lang !== "multi") lang = "multi";

  const closeAll = (reason = "client") => {
    if (closed) return;
    closed = true;
    if (deskCall?.id) {
      try {
        endCall(deskCall.id, reason);
      } catch {
        /* ignore */
      }
    }
    try {
      openai?.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {
      /* ignore */
    }
  };

  const sendTwilio = (payload) => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(payload));
  };

  const sendOpenAi = (payload) => {
    if (openai?.ws?.readyState === WebSocket.OPEN) openai.ws.send(JSON.stringify(payload));
  };

  twilioWs.on("close", () => closeAll("hangup"));
  twilioWs.on("error", () => closeAll("failed"));

  twilioWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const event = msg.event;

    if (event === "connected") return;

    if (event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      const custom = msg.start?.customParameters || {};
      const agentId = String(custom.agentId || agentHint || "").trim();
      const agent = pickAgent(agentId);
      try {
        openai = await openOpenAiRealtime({ lang, agent });
        deskCall = startCall({
          source: "twilio-media",
          agentId: agent?.id || null,
          agentName: agent?.name || null,
          voice: openai.voice,
          toolAllow: agent ? agent.enabledTools : null,
          accountId: agent?.accountId || null,
        });
        openai.ws.on("message", (data) => onOpenAiMessage(String(data)));
        openai.ws.on("close", () => closeAll("realtime-closed"));
        openai.ws.on("error", () => closeAll("failed"));
        if (!greetingSent) {
          greetingSent = true;
          sendOpenAi(greetingEvent(lang, agent));
        }
      } catch (error) {
        console.error("Failed to start Realtime for Media Stream:", error?.message || error);
        closeAll("failed");
      }
      return;
    }

    if (event === "media" && msg.media?.payload) {
      if (deskCall?.id) touchCall(deskCall.id);
      sendOpenAi({ type: "input_audio_buffer.append", audio: msg.media.payload });
      return;
    }

    if (event === "stop") {
      closeAll("hangup");
    }
  });

  async function onOpenAiMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    if (deskCall?.id) touchCall(deskCall.id);

    if (event.type === "input_audio_buffer.speech_started" && greetingDone) noteBargeIn(responseGate);
    const turn = ingestRealtimeEvent(responseGate, event, { suppressFallback: !greetingDone });
    for (const follow of turn.send) sendOpenAi(follow);
    for (const toolCall of turn.toolCalls) {
      const epoch = responseGate.epoch;
      void runToolCall(toolCall, epoch);
    }
    if (event.type === "response.done" && !greetingDone) greetingDone = true;

    if (
      (event.type === "response.output_audio.delta" || event.type === "response.audio.delta")
      && event.delta
      && streamSid
    ) {
      sendTwilio({
        event: "media",
        streamSid,
        media: { payload: event.delta },
      });
      return;
    }

    if (event.type === "input_audio_buffer.speech_started" && streamSid) {
      sendTwilio({ event: "clear", streamSid });
      sendOpenAi({ type: "response.cancel" });
      return;
    }

    const userText = transcriptFrom(event, "user");
    if (userText && deskCall?.id) {
      noteCallerSpeech(responseGate, userText);
      try {
        const outcome = recordRealtimeUtterance({
          callId: deskCall.id,
          role: "user",
          text: userText,
          lang,
        });
        if (outcome.blocked) {
          sendOpenAi({ type: "response.cancel" });
          if (event.item_id) sendOpenAi({ type: "conversation.item.delete", item_id: event.item_id });
          sendOpenAi({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              tool_choice: "none",
              instructions: `Say exactly the following, then stop.

${outcome.reply}`,
            },
          });
        }
        // create_response=true on semantic_vad already answers the caller turn.
      } catch (error) {
        console.error("Utterance screen failed:", error?.message || error);
      }
      return;
    }

    const assistantText = transcriptFrom(event, "assistant");
    if (assistantText && deskCall?.id) {
      try {
        recordRealtimeUtterance({ callId: deskCall.id, role: "assistant", text: assistantText, lang });
      } catch {
        /* ignore duplicate / inactive */
      }
      return;
    }

  }

  async function runToolCall(toolCall, epoch) {
    if (!deskCall?.id) return;
    let args = {};
    try {
      args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
    } catch {
      args = {};
    }
    let ok = false;
    let output = { error: failureLine(toolCall.name) };
    try {
      const outcome = await withTimeout(
        runRealtimeTool({ callId: deskCall.id, name: toolCall.name, args }),
        TOOL_FETCH_TIMEOUT_MS,
        () => ({ ok: false, result: { error: failureLine(toolCall.name) } }),
      );
      ok = Boolean(outcome?.ok);
      output = ok ? (outcome.result ?? {}) : { error: outcome?.result?.error || failureLine(toolCall.name) };
    } catch (error) {
      ok = false;
      output = { error: failureLine(toolCall.name) || error?.message || "Tool failed" };
    }
    sendOpenAi(functionOutputEvent(toolCall.callId, output));
    for (const follow of completeTool(responseGate, toolCall.callId, epoch, ok)) sendOpenAi(follow);
  }
}

function transcriptFrom(event, role) {
  if (role === "user") {
    if (
      event.type === "conversation.item.input_audio_transcription.completed"
      || event.type === "conversation.item.input_audio_transcription.done"
    ) {
      return String(event.transcript || "").trim();
    }
    return "";
  }
  if (
    event.type === "response.output_audio_transcript.done"
    || event.type === "response.audio_transcript.done"
  ) {
    return String(event.transcript || "").trim();
  }
  return "";
}


