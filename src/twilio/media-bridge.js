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
  armToolFiller,
  handleCallerTurn,
  handleCallerPartial,
  queueResponseCreate,
  queueSessionUpdate,
  shouldHoldForSpeech,
  bargeTick,
  setAgentPlayback,
  DUCK_VOLUME,
  withTimeout, toCachedResponse, greetingLanguageNote, createCallBudget } from "../../public/js/realtime-turn.js";
import { realtimeEventFailure } from "../../public/js/voice-failure.js";
import { mulawDurationMs, scaleMulawBase64 } from "./mulaw.js";

/**
 * Agent audio is paced to Twilio ~real time with a small lead instead of being
 * dumped as fast as OpenAI sends it. With a whole reply already buffered at
 * Twilio, neither ducking nor "clear" could act on what the caller hears.
 */
export const AUDIO_LEAD_MS = 500;
import {
  botTaskLine,
  buildRealtimeSession,
  greetingEvent,
  nextSessionAttempt,
  recordRealtimeUtterance,
  runRealtimeTool,
} from "../realtime.js";
import { endCall, startCall, touchCall } from "../store.js";
import { resolveVoiceEngine } from "../cascade/config.js";
import { CASCADE_WS_PATH, cascadeUpgrade, startTwilioCascade } from "../cascade/transport.js";

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
  const cascade = cascadeUpgrade(server);

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === CASCADE_WS_PATH) {
      cascade(req, socket, head);
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
    // Keep create_response=false: replies are created from transcripts.
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
    let attempt = { dropTurnFlags: false, transcription: "multilingual", reasoning: "minimal" };
    const seen = new Set();
    while (attempt && !attempt.nextModel && !attempt.fatal) {
      const keyAttempt = `${attempt.transcription}:${attempt.dropTurnFlags}:${attempt.reasoning}:${attempt.dropBudget}`;
      if (seen.has(keyAttempt)) break;
      seen.add(keyAttempt);
      const session = sessionVariant(
        buildRealtimeSession(model, lang, agent, {
          telephony: true,
          transcription: attempt.transcription,
          reasoning: attempt.reasoning,
          dropBudget: Boolean(attempt.dropBudget),
        }),
        attempt.dropTurnFlags,
      );
      const ws = await connectOpenAiWs(model, key);
      try {
        await waitForEvent(ws, "session.created", 15000);
        ws.send(JSON.stringify({ type: "session.update", session }));
        await waitForEvent(ws, "session.updated", 15000);
        noteRealtimeModel(model);
        return { ws, model, session, botTask: botTaskLine(agent), voice: String(agent?.voice || "").trim() || voiceName() };
      } catch (error) {
        lastError = error?.message || lastError;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        const next = nextSessionAttempt(attempt, 400, lastError);
        if (next?.nextModel || next?.fatal) break;
        attempt = next;
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
  let cascadeLeg = null;
  let deskCall = null;
  let closed = false;
  let greetingSent = false;
  const responseGate = createResponseGate();
  let greetingDone = false;
  const partialTranscripts = new Map();
  const agentHint = String(url.searchParams.get("agentId") || "").trim();
  let lang = String(url.searchParams.get("lang") || "multi").trim().toLowerCase();
  if (lang !== "es" && lang !== "en" && lang !== "multi") lang = "multi";

  let callBudget = null;
  let budgetTimer = null;
  let audioTimer = null;
  let outQueue = [];
  let playbackEndsAt = 0;
  const closeAll = (reason = "client") => {
    if (closed) return;
    closed = true;
    if (budgetTimer) clearInterval(budgetTimer);
    budgetTimer = null;
    if (audioTimer) clearInterval(audioTimer);
    audioTimer = null;
    if (deskCall?.id) {
      try {
        endCall(deskCall.id, reason);
      } catch {
        /* ignore */
      }
    }
    try {
      cascadeLeg?.close();
    } catch {
      /* ignore */
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

  const pumpAudio = (now = Date.now()) => {
    while (outQueue.length && streamSid && playbackEndsAt - now < AUDIO_LEAD_MS) {
      const chunk = outQueue.shift();
      // Unconfirmed caller sound: the agent keeps talking, quieter.
      const payload = responseGate.duck ? scaleMulawBase64(chunk, DUCK_VOLUME) : chunk;
      sendTwilio({ event: "media", streamSid, media: { payload } });
      playbackEndsAt = Math.max(now, playbackEndsAt) + mulawDurationMs(chunk);
      setAgentPlayback(responseGate, true, now);
    }
    if (!outQueue.length && responseGate.playing && now >= playbackEndsAt) setAgentPlayback(responseGate, false, now);
  };

  const clearPlayback = () => {
    outQueue = [];
    playbackEndsAt = Date.now();
    setAgentPlayback(responseGate, false);
    if (streamSid) sendTwilio({ event: "clear", streamSid });
  };

  const sendOpenAi = (payload) => {
    if (openai?.ws?.readyState === WebSocket.OPEN) {
      // Never per-response instructions (they replace the cached prompt): a one-line system note instead.
      for (const item of toCachedResponse(payload, { botTask: openai.botTask || "" })) openai.ws.send(JSON.stringify(item));
    }
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
      const engine = resolveVoiceEngine(agent);
      if (engine.wanted === "cascade" && engine.engine !== "cascade") {
        console.info(`Twilio bridge: cascade wanted but ${engine.status?.label || "not ready"}; using Realtime`);
      }
      if (engine.engine === "cascade") {
        try {
          deskCall = startCall({
            source: "twilio-media",
            agentId: agent?.id || null,
            agentName: agent?.name || null,
            voice: `cascade:${engine.status.tts}`,
            toolAllow: agent ? agent.enabledTools : null,
            accountId: agent?.accountId || null,
          });
          cascadeLeg = await startTwilioCascade({
            callId: deskCall.id,
            agent,
            streamSid,
            status: engine.status,
            send: sendTwilio,
            closeAll,
          });
        } catch (error) {
          console.error("Failed to start cascade for Media Stream:", error?.message || error);
          closeAll("failed");
        }
        return;
      }
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
        audioTimer = setInterval(() => {
          pumpAudio();
          bargeTick(responseGate);
        }, 50);
        // Cost guard: hang up after 30 s with no real speech, and at 10 minutes.
        callBudget = createCallBudget();
        budgetTimer = setInterval(() => {
          const reason = callBudget?.check(shouldHoldForSpeech(responseGate) || !greetingDone);
          if (reason) {
            console.info(`Twilio bridge: ending call (${reason === "max" ? "10-minute limit" : "30 s silence"})`);
            closeAll(reason === "max" ? "max-duration" : "silence");
          }
        }, 1000);
      } catch (error) {
        console.error("Failed to start Realtime for Media Stream:", error?.message || error);
        closeAll("failed");
      }
      return;
    }

    if (event === "media" && msg.media?.payload) {
      if (deskCall?.id) touchCall(deskCall.id);
      if (cascadeLeg) {
        cascadeLeg.pushMulaw(msg.media.payload);
        return;
      }
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

    const accountFailure = realtimeEventFailure(event);
    if (accountFailure) {
      console.error(`Twilio bridge: OpenAI account failure (${accountFailure.message})`);
      closeAll("failed");
      return;
    }

    const turn = ingestRealtimeEvent(responseGate, event, { suppressFallback: !greetingDone });
    for (const follow of turn.send) sendOpenAi(follow);
    if (turn.toolCalls.length) armToolFiller(responseGate, sendOpenAi);
    for (const toolCall of turn.toolCalls) {
      const epoch = responseGate.epoch;
      void runToolCall(toolCall, epoch);
    }
    if (event.type === "response.done" && !greetingDone) {
      greetingDone = true;
      sendOpenAi(greetingLanguageNote());
    }

    if (
      (event.type === "response.output_audio.delta" || event.type === "response.audio.delta")
      && event.delta
      && streamSid
    ) {
      callBudget?.noteActivity();
      outQueue.push(event.delta);
      pumpAudio();
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta && event.item_id) {
      const soFar = `${partialTranscripts.get(event.item_id) || ""}${event.delta}`;
      partialTranscripts.set(event.item_id, soFar);
      const early = handleCallerPartial(responseGate, soFar, { itemId: event.item_id });
      if (early?.kind === "speech") {
        if (early.cancel) {
          console.info(`call-trace ${deskCall?.id || "twilio"} interrupt partial`);
          clearPlayback();
          sendOpenAi({ type: "response.cancel" });
        }
        for (const follow of early.send) sendOpenAi(follow);
      }
      return;
    }
    // speech_started only ducks (ingestRealtimeEvent -> bargeSpeechStart).
    // handleCallerTurn stops the agent only for confirmed interrupting speech.
    const userText = transcriptFrom(event, "user");
    if (userText && deskCall?.id) {
      const callerTurn = handleCallerTurn(responseGate, userText, { itemId: event.item_id });
      partialTranscripts.delete(event.item_id);
      if (callerTurn.kind === "noise" || callerTurn.kind === "short" || callerTurn.kind === "ignored") {
        console.info(`call-trace ${deskCall.id} drop-${callerTurn.reason || callerTurn.kind}`);
        if (callerTurn.deleteItem && event.item_id) sendOpenAi({ type: "conversation.item.delete", item_id: event.item_id });
        return;
      }
      if (responseGate.callerLanguage) lang = responseGate.callerLanguage;
      if (callerTurn.cancel) {
        console.info(`call-trace ${deskCall.id} interrupt`);
        clearPlayback();
        sendOpenAi({ type: "response.cancel" });
      }
      for (const follow of callerTurn.send) sendOpenAi(follow);
      // No session.update on a language switch: the per-reply note carries the
      // language, and new instructions would bust the prompt cache.
      callBudget?.noteActivity();
      try {
        const outcome = recordRealtimeUtterance({
          callId: deskCall.id,
          role: "user",
          text: userText,
          lang,
        });
        if (outcome.blocked) {
          if (responseGate.active) sendOpenAi({ type: "response.cancel" });
          if (event.item_id) sendOpenAi({ type: "conversation.item.delete", item_id: event.item_id });
          for (const follow of queueResponseCreate(responseGate, {
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              tool_choice: "none",
              instructions: `Say exactly the following, then stop.

${outcome.reply}`,
            },
          })) sendOpenAi(follow);
        }
        // handleCallerTurn sent the reply (create_response=false on the session).
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


