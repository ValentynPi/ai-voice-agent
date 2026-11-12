// Small accuracy check for Azure STT language handling. Uses AZURE_SPEECH_KEY/REGION from env.
// node scripts/azure-stt-eval.mjs [configName...]
import fs from "node:fs";
import path from "node:path";
import { openAzureTts, openAzureStt, openAzureRecognizer } from "../src/cascade/azure.js";
import { mulawEncode } from "../src/twilio/mulaw.js";
const pcm16ToMulaw = (pcm) => { const o = Buffer.alloc(pcm.length / 2); for (let i = 0; i < o.length; i += 1) o[i] = mulawEncode(pcm.readInt16LE(i * 2)); return o; };

const CACHE = "/tmp/azure-eval-clips";
fs.mkdirSync(CACHE, { recursive: true });
export const PHRASES = [
  ["uk", "Привіт, що ти вмієш?", "female"],
  ["uk", "Яка погода в Києві?", "male"],
  ["uk", "Яка погода завтра у Львові?", "female"],
  ["uk", "Дякую.", "male"],
  ["he", "מה מזג האוויר בתל אביב?", "female"],
  ["he", "שלום, מה אתה יודע לעשות?", "male"],
  ["he", "תודה רבה.", "female"],
  ["en", "What is the weather in Madrid?", "male"],
  ["en", "Hello, what can you do?", "female"],
];

async function synth(lang, text, gender) {
  const file = path.join(CACHE, `${lang}-${Buffer.from(text).toString("hex").slice(0, 24)}-${gender}.pcm`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  process.env.AZURE_TTS_GENDER = gender;
  const parts = [];
  const tts = openAzureTts({ language: lang, format: "pcm16k", onAudio: (b) => parts.push(b) });
  tts.send(text); tts.end(); await tts.done;
  const buf = Buffer.concat(parts);
  fs.writeFileSync(file, buf);
  return buf;
}

function addNoise(pcm, level = 300) {
  const out = Buffer.from(pcm);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const s = out.readInt16LE(i) * 0.6 + (Math.random() * 2 - 1) * level;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i);
  }
  return out;
}

function downsample8k(pcm16k) {
  const n = Math.floor(pcm16k.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const a = pcm16k.readInt16LE(i * 4), b = pcm16k.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.round((a + b) / 2), i * 2);
  }
  return out;
}

export async function recognize(audio, format, sttOptions = {}, paceMs = 20) {
  const results = [];
  const { raw, verbose, ...rest } = sttOptions;
  const open = raw ? openAzureRecognizer : openAzureStt;
  const t0 = Date.now();
  const stt = open({ format, onPartial: () => {}, onCommitted: (text, lang, info) => results.push({ text, lang, info, at: Date.now() - t0 }), onError: (e) => results.push({ error: e.code }), log: verbose ? (k, d) => console.log("   ", k, d) : () => {}, ...rest });
  await stt.ready;
  const bytesPerMs = format === "mulaw8k" ? 8 : 32;
  const frame = 40 * bytesPerMs;
  const silence = Buffer.alloc(800 * bytesPerMs, format === "mulaw8k" ? 0xff : 0);
  const tail = Buffer.alloc(1800 * bytesPerMs, format === "mulaw8k" ? 0xff : 0);
  const all = Buffer.concat([silence, audio, tail]);
  for (let i = 0; i < all.length; i += frame) {
    stt.send(all.subarray(i, i + frame));
    await new Promise((r) => setTimeout(r, paceMs)); // 20 = 2x real time
  }
  await new Promise((r) => setTimeout(r, 3000));
  stt.close();
  return results;
}

export async function clips({ noisy = false } = {}) {
  const out = [];
  for (const [lang, text, gender] of PHRASES) {
    let pcm = await synth(lang, text, gender);
    if (noisy) pcm = addNoise(pcm);
    out.push({ lang, text, pcm16k: pcm, mulaw: pcm16ToMulaw(downsample8k(pcm)) });
  }
  return out;
}

async function callScenario(format, opts) {
  const list = await clips();
  const pick = (t) => list.find((c) => c.text === t);
  const order = ["Привіт, що ти вмієш?", "Дякую.", "Яка погода завтра у Львові?", "מה מזג האוויר בתל אביב?", "תודה רבה.", "What is the weather in Madrid?", "Яка погода в Києві?"];
  const bytesPerMs = format === "mulaw8k" ? 8 : 32;
  const gap = Buffer.alloc(2500 * bytesPerMs, format === "mulaw8k" ? 0xff : 0);
  const audio = Buffer.concat(order.flatMap((t) => [format === "mulaw8k" ? pick(t).mulaw : pick(t).pcm16k, gap]));
  const res = await recognize(audio, format, opts, 40);
  for (const r of res) console.log(r.text ? `  ${r.lang}: ${r.text} (c=${r.info?.confidence?.toFixed?.(2)}${r.info?.rechecked ? " rechecked" : ""})` : JSON.stringify(r));
  console.log("expected:", order.join(" / "));
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("call")) {
  await callScenario(process.argv[2] || "pcm16k", JSON.parse(process.argv.find((a) => a.startsWith("{")) || "{}"));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const format = process.argv[2] || "pcm16k";
  const noisy = process.argv.includes("noisy");
  const optsJson = process.argv.find((a) => a.startsWith("{")) || "{}";
  const opts = JSON.parse(optsJson);
  let ok = 0, langOk = 0;
  const list = await clips({ noisy });
  for (const c of list) {
    const res = await recognize(format === "mulaw8k" ? c.mulaw : c.pcm16k, format, opts);
    const got = res.filter((r) => r.text).map((r) => `${r.lang}:${r.text} (c=${r.info?.confidence?.toFixed?.(2)} lid=${r.info?.lidConfidence})`).join(" | ") || JSON.stringify(res);
    const lid = res.some((r) => r.lang === c.lang);
    if (lid) langOk += 1;
    console.log(`${lid ? "OK " : "BAD"} [${c.lang}] ${c.text}  ->  ${got}`);
  }
  console.log(`language right: ${langOk}/${list.length}`);
}
