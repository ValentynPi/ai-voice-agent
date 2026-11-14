/**
 * Browser side of the Cascade voice engine. The server holds every provider
 * key: this streams the mic (PCM16 16 kHz) to /api/cascade/ws and plays the
 * agent's PCM16 16 kHz audio back. Turn-taking (noise, "yeah"/"ага",
 * barge-in) is decided on the server; the page only obeys clear / volume.
 *
 * Playback goes WebAudio -> MediaStream -> the <audio> element, so the
 * browser's echo canceller sees the agent's voice like a WebRTC call.
 */

export const CASCADE_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 640; // 40 ms

const WORKLET = `
class CascadeMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${CASCADE_SAMPLE_RATE};
    this.pos = 0;
    this.out = [];
    // Anti-alias low-pass (2nd order, ~7 kHz) before going down to 16 kHz, so
    // hiss and sibilants do not fold into the speech band the recognizer uses.
    const w = 2 * Math.PI * Math.min(7000, sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = ((1 - Math.cos(w)) / 2) / a0;
    this.b1 = (1 - Math.cos(w)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.filter = this.ratio > 1.01;
  }
  lowpass(input) {
    if (!this.filter) return input;
    const out = new Float32Array(input.length);
    for (let n = 0; n < input.length; n += 1) {
      const x = input[n];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      out[n] = y;
    }
    return out;
  }
  process(inputs) {
    const raw = inputs[0] && inputs[0][0];
    if (!raw) return true;
    const input = this.lowpass(raw);
    // Linear-interpolation resample from the context rate to 16 kHz.
    while (this.pos < input.length - 1) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      this.out.push(input[i] * (1 - f) + input[i + 1] * f);
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    if (this.pos < 0) this.pos = 0;
    while (this.out.length >= ${FRAME_SAMPLES}) {
      const chunk = this.out.splice(0, ${FRAME_SAMPLES});
      const pcm = new Int16Array(chunk.length);
      for (let k = 0; k < chunk.length; k += 1) {
        const s = Math.max(-1, Math.min(1, chunk[k]));
        pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("cascade-mic", CascadeMic);

// Agent voice: one continuous stream. Chunks are queued sample-exact and
// resampled with one running interpolator (plus a low-pass against imaging),
// so there are no clicks or gaps where network chunks meet.
class CascadePlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.setRate(${CASCADE_SAMPLE_RATE});
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === "rate") { this.setRate(Number(data.rate) || ${CASCADE_SAMPLE_RATE}); return; }
      if (data && data.type === "clear") { this.reset(); return; }
      if (data instanceof Float32Array && data.length) { this.queue.push(data); this.buffered += data.length; }
    };
  }
  setRate(rate) {
    this.inRate = rate;
    this.step = rate / sampleRate;
    this.prebuffer = Math.round(rate * 0.06); // 60 ms jitter cushion before (re)starting
    const fc = Math.min(rate * 0.45, sampleRate * 0.45);
    const w = 2 * Math.PI * fc / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = ((1 - Math.cos(w)) / 2) / a0;
    this.b1 = (1 - Math.cos(w)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
    this.filter = sampleRate > rate * 1.01;
    this.reset();
  }
  reset() {
    this.queue = [];
    this.head = null;
    this.headPos = 0;
    this.buffered = 0;
    this.playing = false;
    this.pos = 1;
    this.prev = 0;
    this.cur = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  take() {
    while (!this.head || this.headPos >= this.head.length) {
      if (!this.queue.length) return null;
      this.head = this.queue.shift();
      this.headPos = 0;
    }
    this.buffered -= 1;
    return this.head[this.headPos++];
  }
  process(_inputs, outputs) {
    const channels = outputs[0];
    const out = channels && channels[0];
    if (!out) return true;
    if (!this.playing && this.buffered >= this.prebuffer) this.playing = true;
    for (let n = 0; n < out.length; n += 1) {
      let y = 0;
      if (this.playing) {
        while (this.pos >= 1) {
          const s = this.take();
          if (s === null) { this.playing = false; this.prev = 0; this.cur = 0; this.pos = 1; break; }
          this.prev = this.cur;
          this.cur = s;
          this.pos -= 1;
        }
        if (this.playing) {
          y = this.prev + (this.cur - this.prev) * this.pos;
          this.pos += this.step;
        }
      }
      if (this.filter) {
        const f = this.b0 * y + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1; this.x1 = y; this.y2 = this.y1; this.y1 = f;
        y = f;
      }
      out[n] = y;
    }
    for (let c = 1; c < channels.length; c += 1) channels[c].set(out);
    return true;
  }
}
registerProcessor("cascade-player", CascadePlayer);
`;

/** Agent audio the page asks for (Azure voices are native 24 kHz). */
export const CASCADE_PLAYBACK_RATE = 24000;

/** PCM16 LE bytes -> Float32 samples. */
export function pcm16ToFloat32(buffer) {
  const view = new DataView(buffer);
  const out = new Float32Array(Math.floor(buffer.byteLength / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export function cascadeWsUrl(wsPath, ticket, loc = globalThis.location, { rate = 0 } = {}) {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}${wsPath}?ticket=${encodeURIComponent(ticket)}${rate ? `&rate=${rate}` : ""}`;
}

/** Plain text for a failed /api/cascade/session. */
export function cascadeSessionFailure(status, body = {}) {
  if (body?.code === "cascade_not_ready") return body.error || "Cascade voice needs provider keys on the server.";
  if (status === 409) return "The call already ended.";
  if (status === 401 || status === 403) return "Sign in, then try Start call again.";
  return body?.error || `Cascade voice could not start (HTTP ${status}).`;
}

export async function startCascadeCall({
  callId,
  remoteAudio,
  onPhase = () => {},
  onTranscript = () => {},
  onInterim = () => {},
  onError = () => {},
  onEnded = () => {},
  onTrace = () => {},
} = {}) {
  const response = await fetch("/api/cascade/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ticket) {
    const error = new Error(cascadeSessionFailure(response.status, body));
    error.kind = body?.code === "cascade_not_ready" ? "cascade" : "";
    throw error;
  }

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true }, channelCount: 1 },
  });
  const settings = mic.getAudioTracks()[0]?.getSettings?.() || {};
  onTrace("mic", `cascade ec=${settings.echoCancellation} ns=${settings.noiseSuppression}`);

  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  gain.connect(dest);
  if (remoteAudio) {
    remoteAudio.srcObject = dest.stream;
    remoteAudio.volume = 1;
    remoteAudio.play?.().catch(() => {});
  } else {
    gain.connect(ctx.destination);
  }

  let stopped = false;
  let nextTime = 0;
  let playbackRate = CASCADE_SAMPLE_RATE;
  const sources = new Set();
  let player = null;
  if (ctx.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    player = new AudioWorkletNode(ctx, "cascade-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    player.connect(gain);
  }
  const ws = new WebSocket(cascadeWsUrl(body.wsPath || "/api/cascade/ws", body.ticket, globalThis.location, { rate: player ? CASCADE_PLAYBACK_RATE : 0 }));
  ws.binaryType = "arraybuffer";

  const setPlaybackRate = (rate) => {
    playbackRate = rate === 24000 || rate === 16000 ? rate : CASCADE_SAMPLE_RATE;
    player?.port.postMessage({ type: "rate", rate: playbackRate });
  };

  const clearPlayback = () => {
    player?.port.postMessage({ type: "clear" });
    for (const src of sources) { try { src.stop(); } catch { /* ignore */ } }
    sources.clear();
    nextTime = 0;
  };

  const play = (buffer) => {
    const samples = pcm16ToFloat32(buffer);
    if (!samples.length) return;
    if (player) { player.port.postMessage(samples, [samples.buffer]); return; }
    // No AudioWorklet (old browsers): schedule buffers back to back.
    const audio = ctx.createBuffer(1, samples.length, playbackRate);
    audio.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(gain);
    const at = Math.max(ctx.currentTime + 0.04, nextTime);
    src.start(at);
    nextTime = at + audio.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
  };

  const source = ctx.createMediaStreamSource(mic);
  let node = null;
  const sendFrame = (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(frame); };
  if (ctx.audioWorklet) {
    node = new AudioWorkletNode(ctx, "cascade-mic");
    node.port.onmessage = (event) => sendFrame(event.data);
  } else {
    // Old browsers: ScriptProcessor + naive decimation.
    node = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / CASCADE_SAMPLE_RATE;
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(Math.floor(input.length / ratio));
      for (let i = 0; i < pcm.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      sendFrame(pcm.buffer);
    };
  }
  source.connect(node);
  // A worklet/processor must reach a destination to run; send it nowhere audible.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" })); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
    clearPlayback();
    try { source.disconnect(); node.disconnect(); player?.disconnect(); } catch { /* ignore */ }
    mic.getTracks().forEach((track) => track.stop());
    ctx.close().catch(() => {});
    if (remoteAudio) { remoteAudio.pause?.(); remoteAudio.srcObject = null; }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Cascade voice did not connect.")), 15000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cascade voice connection failed.")); }, { once: true });
  }).catch((error) => { stop(); throw error; });

  let endedByServer = false;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") { play(event.data); return; }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "clear") { clearPlayback(); onTrace("interrupt", "server"); }
    else if (msg.type === "volume") {
      gain.gain.setTargetAtTime(Number(msg.value) || 1, ctx.currentTime, 0.03);
      onTrace(Number(msg.value) < 1 ? "duck" : "restore", "cascade");
    } else if (msg.type === "ready") setPlaybackRate(Number(msg.playbackRate) || CASCADE_SAMPLE_RATE);
    else if (msg.type === "notice") onTrace("notice", msg.code || "");
    else if (msg.type === "phase") onPhase(msg.state);
    else if (msg.type === "interim") onInterim(msg.text || "");
    else if (msg.type === "transcript") onTranscript(msg.role, msg.text || "", msg.language || "");
    else if (msg.type === "error") onError(msg.message || "Voice failed", msg.code || "");
    else if (msg.type === "ended") { endedByServer = true; onEnded(msg.reason || ""); }
  });
  ws.addEventListener("close", () => {
    if (!stopped && !endedByServer) onEnded("closed");
    stop();
  });

  return { stop, stt: body.stt, tts: body.tts, llm: body.llm, label: body.label };
}
