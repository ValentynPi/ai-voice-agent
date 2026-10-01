import WebSocket from "ws";
import { isSid, randomSid } from "./ids.js";
import { normalizeAgentsBaseUrl, resolveAgentsPublicUrl } from "./public-url.js";
import { demoAccountSid, recordEvent, upsertCall } from "./store.js";

/**
 * Simulate an inbound Twilio call into the Agents brain without carrier credentials.
 * 1) POST /twilio/voice on the Agents host
 * 2) Parse <Stream url="...">
 * 3) Open a short Media Streams WebSocket and wait for Realtime audio (or timeout)
 */
export async function runDemoCall(req, { agentsBaseUrl, agentId, from, to } = {}) {
  const agentsBase = normalizeAgentsBaseUrl(agentsBaseUrl || resolveAgentsPublicUrl(req) || "");
  if (!agentsBase) {
    const error = new Error("Set AGENTS_PUBLIC_URL (or paste an Agents brain URL) before running a demo call");
    error.status = 400;
    error.expose = true;
    throw error;
  }

  const callSid = randomSid("CA");
  const voiceUrl = new URL(`${agentsBase}/twilio/voice`);
  if (agentId) voiceUrl.searchParams.set("agentId", agentId);

  const caller = String(from || "+34600111222").trim();
  const callee = String(to || "+34964000214").trim();
  const form = new URLSearchParams({
    CallSid: callSid,
    From: caller,
    To: callee,
    CallStatus: "ringing",
    Direction: "inbound",
    AccountSid: demoAccountSid(),
  });

  const voiceRes = await fetch(voiceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/xml" },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const twiml = await voiceRes.text();
  if (!voiceRes.ok) {
    const error = new Error(`Agents voice webhook returned ${voiceRes.status}`);
    error.status = 502;
    error.expose = true;
    throw error;
  }

  const streamMatch = twiml.match(/<Stream[^>]*\surl=["']([^"']+)["']/i);
  const streamUrl = streamMatch
    ? streamMatch[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
    : "";
  const usesStream = /<Stream[\s>]/i.test(twiml) || /<Connect[\s>]/i.test(twiml);
  const usesSayStub = /<Say[\s>]/i.test(twiml) && !usesStream;

  upsertCall({
    sid: callSid,
    accountSid: demoAccountSid(),
    from: caller,
    to: callee,
    direction: "inbound",
    status: "in-progress",
    media: "demo-media-stream",
    annotation: `Demo call to Agents brain at ${agentsBase}`,
    demo: true,
  });

  recordEvent({
    accountSid: demoAccountSid(),
    method: "POST",
    url: "/api/twilio/v1/demo-call",
    callSid,
    variables: { AgentsBase: agentsBase, AgentId: agentId || "", StreamUrl: streamUrl },
    status: 200,
    body: twiml.slice(0, 2000),
    level: "info",
    message: "Demo call posted to Agents voice webhook",
    signature: "absent",
  });

  let media = {
    attempted: false,
    connected: false,
    audioFrames: 0,
    error: "",
  };

  if (streamUrl) {
    media = await probeMediaStream(streamUrl, callSid, agentId);
  } else {
    media.error = usesSayStub
      ? "Agents still returned a Say stub — Media Streams is not connected on that host"
      : "No Stream URL in TwiML (check PUBLIC_URL / FLY_APP_NAME on Agents)";
  }

  const terminal = media.audioFrames > 0 ? "completed" : media.connected ? "completed" : "failed";
  upsertCall({
    sid: callSid,
    accountSid: demoAccountSid(),
    from: caller,
    to: callee,
    direction: "inbound",
    status: terminal,
    endTime: new Date().toISOString(),
    duration: media.audioFrames > 0 ? 2 : 0,
    media: "demo-media-stream",
    annotation: media.audioFrames > 0
      ? "Demo call received Realtime audio from Agents brain"
      : media.error || "Demo call reached Agents webhook",
    demo: true,
  });

  return {
    ok: usesStream && !usesSayStub,
    call_sid: callSid,
    agents_base_url: agentsBase,
    voice_url: voiceUrl.toString(),
    agent_id: agentId || null,
    twiml,
    stream_url: streamUrl || null,
    uses_stream: usesStream,
    uses_say_stub: usesSayStub,
    media,
  };
}

function probeMediaStream(streamUrl, callSid, agentId) {
  return new Promise((resolve) => {
    const result = { attempted: true, connected: false, audioFrames: 0, error: "" };
    let settled = false;
    const finish = (partial = {}) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ...result, ...partial });
    };

    let ws;
    try {
      ws = new WebSocket(streamUrl);
    } catch (error) {
      finish({ error: error?.message || "Could not open Media Stream WebSocket" });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        error: result.audioFrames
          ? ""
          : result.connected
            ? "Connected to Media Stream but no Realtime audio arrived (is OPENAI_API_KEY set on Agents?)"
            : "Timed out connecting to Media Stream",
      });
    }, 12000);

    ws.on("open", () => {
      result.connected = true;
      const streamSid = randomSid("MZ");
      ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      ws.send(JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: {
          streamSid,
          accountSid: demoAccountSid(),
          callSid: isSid(callSid, "CA") ? callSid : randomSid("CA"),
          tracks: ["inbound"],
          customParameters: agentId ? { agentId: String(agentId) } : {},
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
        streamSid,
      }));
      // ~20ms of silence (mulaw 0xff), base64
      const silence = Buffer.alloc(160, 0xff).toString("base64");
      let seq = 2;
      const tick = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(tick);
          return;
        }
        ws.send(JSON.stringify({
          event: "media",
          sequenceNumber: String(seq++),
          media: { track: "inbound", chunk: String(seq), timestamp: String(Date.now()), payload: silence },
          streamSid,
        }));
      }, 20);
      setTimeout(() => clearInterval(tick), 2500);
      // If we already heard agent audio, wrap up after a short listen window.
      setTimeout(() => {
        if (result.audioFrames > 0) {
          clearTimeout(timer);
          try {
            ws.send(JSON.stringify({ event: "stop", streamSid }));
          } catch {
            /* ignore */
          }
          finish();
        }
      }, 8000);
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.event === "media" && msg.media?.payload) {
        result.audioFrames += 1;
        if (result.audioFrames >= 3) {
          clearTimeout(timer);
          finish();
        }
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      finish({ error: error?.message || "Media Stream WebSocket error" });
    });

    ws.on("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
