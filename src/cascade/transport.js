/**
 * Transports for the cascade engine.
 *  - Browser: POST /api/cascade/session -> one-time ticket, then a WebSocket
 *    /api/cascade/ws?ticket=… carrying PCM16 16 kHz mic audio up and PCM16
 *    16 kHz agent audio down (JSON frames for clear/volume/transcripts).
 *  - Twilio Media Streams: mulaw 8 kHz both ways through the same session.
 *  - Telephony host: proxies /api/cascade/ws to the Agents brain, so browser
 *    calls stay on the telephony origin.
 */
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { getAgent, getDefaultAgent } from "../desk.js";
import { ensureMcp } from "../mcp/connection.js";
import {
  botTaskLine,
  realtimeToolSpecs,
  receptionistInstructions,
  recordRealtimeUtterance,
  runRealtimeTool,
  selectSessionTools,
} from "../realtime.js";
import { getCall, touchCall } from "../store.js";
import { normalizeAgentsBaseUrl } from "../twilio/public-url.js";
import { telephonySharedSecret } from "../twilio/public-list.js";
import { openAzureStt, openAzureTts } from "./azure.js";
import { cascadeStatus } from "./config.js";
import { openDeepgramStt } from "./deepgram.js";
import { openElevenTts, openScribeStt } from "./elevenlabs.js";
import { chatTool, streamChat } from "./llm.js";
import { CASCADE_VOICE_RULES, createCascadeSession } from "./session.js";

export const CASCADE_WS_PATH = "/api/cascade/ws";
const TICKET_TTL_MS = 60_000;
const tickets = new Map();

export function issueCascadeTicket(callId) {
  const ticket = crypto.randomBytes(24).toString("base64url");
  tickets.set(ticket, { callId, expires: Date.now() + TICKET_TTL_MS });
  for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
  return ticket;
}

/** One use only. */
export function redeemCascadeTicket(ticket) {
  const entry = tickets.get(String(ticket || ""));
  if (!entry) return null;
  tickets.delete(String(ticket));
  return entry.expires >= Date.now() ? entry.callId : null;
}

export function cascadeProvidersFor(status = cascadeStatus()) {
  return {
    openStt: status.stt === "azure" ? openAzureStt : status.stt === "deepgram" ? openDeepgramStt : openScribeStt,
    openTts: status.tts === "azure" ? openAzureTts : openElevenTts,
  };
}

/** Everything the session needs from the agent: stable instructions, tools, task line. */
export async function cascadeAgentSetup(agent) {
  await ensureMcp();
  const specs = selectSessionTools(realtimeToolSpecs(), agent);
  const tools = specs.map(chatTool);
  const instructions = `${receptionistInstructions("multi", agent, { toolCount: tools.length })}\n\n${CASCADE_VOICE_RULES}`;
  return { tools, instructions, botTask: botTaskLine(agent) };
}

function agentForCall(call) {
  return (call.agentId && getAgent(call.agentId)) || getDefaultAgent(call.accountId);
}

export async function handleBrowserCascade(ws, url, { status = cascadeStatus(), providers = cascadeProvidersFor(status), llm = streamChat, tickMs = 40 } = {}) {
  const callId = redeemCascadeTicket(url.searchParams.get("ticket"));
  const sendJson = (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
  const call = callId ? getCall(callId) : null;
  if (!call || call.status !== "active") {
    sendJson({ type: "error", code: "cascade_ticket", message: "This voice link expired. Start the call again." });
    ws.close();
    return null;
  }
  if (!status.ready) {
    sendJson({ type: "error", code: "cascade_not_ready", message: status.label });
    ws.close();
    return null;
  }
  const agent = agentForCall(call);
  const setup = await cascadeAgentSetup(agent);
  let ticker = null;
  const session = createCascadeSession({
    callId,
    agent,
    format: "pcm16k",
    ...setup,
    ...providers,
    llm,
    runTool: runRealtimeTool,
    record: recordRealtimeUtterance,
    output: {
      audio: (buf) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true }); },
      clear: () => sendJson({ type: "clear" }),
      volume: (value) => sendJson({ type: "volume", value }),
      event: sendJson,
      end: (reason) => {
        if (ticker) clearInterval(ticker);
        sendJson({ type: "closed", reason });
        try { ws.close(); } catch { /* ignore */ }
      },
    },
  });
  let lastTouch = 0;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const t = Date.now();
      if (t - lastTouch > 2000) { lastTouch = t; touchCall(callId); }
      session.pushAudio(Buffer.from(data));
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.type === "stop") session.close("client");
  });
  ws.on("close", () => session.close("client"));
  ws.on("error", () => session.close("failed"));
  ticker = setInterval(() => session.tick(), tickMs);
  console.info(`call-trace ${callId} cascade start stt=${status.stt} tts=${status.tts} llm=${status.llm}`);
  await session.start();
  return session;
}

/**
 * Twilio leg. `send` posts a Twilio JSON frame; `closeAll(reason)` ends the call.
 * Returns { pushMulaw(base64), close() }.
 */
export async function startTwilioCascade({ callId, agent, streamSid, send, closeAll, status = cascadeStatus(), providers = cascadeProvidersFor(status) }) {
  const setup = await cascadeAgentSetup(agent);
  let ticker = null;
  const session = createCascadeSession({
    callId,
    agent,
    format: "mulaw8k",
    ...setup,
    ...providers,
    llm: streamChat,
    runTool: runRealtimeTool,
    record: recordRealtimeUtterance,
    output: {
      audio: (buf) => send({ event: "media", streamSid, media: { payload: Buffer.from(buf).toString("base64") } }),
      clear: () => send({ event: "clear", streamSid }),
      end: (reason) => {
        if (ticker) clearInterval(ticker);
        closeAll(reason === "client" ? "hangup" : reason);
      },
    },
  });
  ticker = setInterval(() => session.tick(), 40);
  console.info(`call-trace ${callId} cascade start twilio stt=${status.stt} tts=${status.tts} llm=${status.llm}`);
  void session.start();
  return {
    pushMulaw(payload) { session.pushAudio(Buffer.from(String(payload || ""), "base64")); },
    close() { session.close("hangup"); },
  };
}

const cascadeServers = new WeakMap();
/** WebSocketServer for browser cascade upgrades on the Agents host. */
export function cascadeUpgrade(server) {
  let wss = cascadeServers.get(server);
  if (!wss) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    cascadeServers.set(server, wss);
  }
  return (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url || "/", "http://localhost");
      handleBrowserCascade(ws, url).catch((error) => {
        console.error("Cascade voice failed:", error?.message || error);
        try { ws.close(); } catch { /* ignore */ }
      });
    });
  };
}

/** Telephony host: forward /api/cascade/ws to the Agents brain (same ticket). */
export function attachCascadeProxy(server, agentsPublicUrl) {
  const base = normalizeAgentsBaseUrl(agentsPublicUrl || "");
  if (!server || !base) return false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url || "/", "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== CASCADE_WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      const target = `${base.replace(/^http/, "ws")}${CASCADE_WS_PATH}?ticket=${encodeURIComponent(url.searchParams.get("ticket") || "")}`;
      const headers = {};
      const secret = telephonySharedSecret();
      if (secret) headers["X-Telephony-Secret"] = secret;
      const upstream = new WebSocket(target, { headers });
      const pending = [];
      upstream.on("open", () => { for (const [data, binary] of pending.splice(0)) upstream.send(data, { binary }); });
      upstream.on("message", (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
      client.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 200) pending.push([data, binary]);
      });
      const shut = () => {
        try { client.close(); } catch { /* ignore */ }
        try { upstream.close(); } catch { /* ignore */ }
      };
      upstream.on("close", shut);
      upstream.on("error", shut);
      client.on("close", shut);
      client.on("error", shut);
    });
  });
  return true;
}
