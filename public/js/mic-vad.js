/**
 * Browser mic level VAD for WebRTC calls (see "no server VAD while the agent
 * talks" in realtime-turn.js). Reads the echo-cancelled mic track through an
 * AnalyserNode and reports "start" / "end" (with ms of sound). Returns null
 * when Web Audio is missing, so the caller keeps plain server VAD.
 */
import { createLevelVad, stepLevelVad } from "./realtime-turn.js";

export function startMicVad(stream, onEvent, { intervalMs = 20, now = () => Date.now() } = {}) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx || !stream || typeof onEvent !== "function") return null;
  let ctx;
  let source;
  let analyser;
  try {
    ctx = new Ctx();
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch {
    try { ctx?.close?.(); } catch { /* ignore */ }
    return null;
  }
  try { void ctx.resume?.()?.catch?.(() => {}); } catch { /* ignore */ }
  const buf = new Float32Array(analyser.fftSize);
  const vad = createLevelVad();
  const timer = setInterval(() => {
    if (ctx.state === "suspended") { try { void ctx.resume?.()?.catch?.(() => {}); } catch { /* ignore */ } }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
    const db = 10 * Math.log10(sum / buf.length + 1e-12);
    const step = stepLevelVad(vad, db, now());
    if (step.event) {
      try { onEvent(step.event, step.ms, db); } catch { /* never break the loop */ }
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      try { source.disconnect(); } catch { /* ignore */ }
      try { void ctx.close?.()?.catch?.(() => {}); } catch { /* ignore */ }
    },
  };
}
