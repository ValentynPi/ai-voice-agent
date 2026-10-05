/**
 * Shared caller-language path for the telephony bridge and both web dialers.
 * Input transcription stays multilingual. A single language is never pinned
 * to English. A hint, when we have one, is the caller's latest turn.
 */

export const TRANSCRIPTION_LANGUAGES = ["uk", "es", "en", "ru", "fr", "ar", "he"];

const NAMES = {
  uk: "Ukrainian",
  es: "Spanish",
  en: "English",
  ru: "Russian",
  fr: "French",
  ar: "Arabic",
  he: "Hebrew",
};

const FAILURES = {
  uk: { weather: "Зараз не можу дізнатися погоду.", other: "Зараз не можу це зробити." },
  es: { weather: "Ahora no puedo consultar el tiempo.", other: "Ahora no puedo hacer eso." },
  en: { weather: "I can't get the weather right now.", other: "I can't do that right now." },
  ru: { weather: "Сейчас не могу узнать погоду.", other: "Сейчас не могу это сделать." },
  fr: { weather: "Je ne peux pas avoir la météo pour le moment.", other: "Je ne peux pas faire ça maintenant." },
  ar: { weather: "لا أستطيع معرفة الطقس الآن.", other: "لا أستطيع فعل ذلك الآن." },
  he: { weather: "אני לא יכול לבדוק את מזג האוויר עכשיו.", other: "אני לא יכול לעשות את זה עכשיו." },
};

const PLACE_NAME = /castell[oó]n(?:\s+de\s+la\s+plana)?|кастельон(?:-де-ла-плана)?|кастельйон(?:-де-ла-плана)?/gi;

/** Place names are not evidence of a language. */
export function withoutPlaceNames(text) {
  return String(text || "").replace(PLACE_NAME, " ");
}

function contentWords(text) {
  return withoutPlaceNames(text).match(/\p{L}{2,}/gu) || [];
}

/**
 * Guess the language of a transcript. A place name, one function word,
 * or a short noisy fragment returns "" so it cannot flip the call.
 */
export function detectCallerLanguage(text) {
  const value = withoutPlaceNames(text);
  if (!contentWords(value).length && !/[\u0590-\u05FF\u0600-\u06FF\u0400-\u04FF]/.test(value)) return "";
  if ((value.match(/[\u0590-\u05FF]/g) || []).length >= 2) return "he";
  if ((value.match(/[\u0600-\u06FF]/g) || []).length >= 2) return "ar";
  if (/[\u0400-\u04FF]/.test(value)) {
    if (/[іїєґІЇЄҐ]/.test(value) || /привіт|будь ласка|сьогодні|скажи|дякую|яка|який|яке|які|мені/i.test(value)) {
      return "uk";
    }
    if (contentWords(value).length < 2) return "";
    return "ru";
  }
  const sample = value.normalize("NFD").replace(/\p{M}/gu, "");
  const esHits = sample.match(/\b(hola|gracias|por favor|tiempo|clima|que|como|donde|hoy|buenos|buenas)\b/gi)?.length || 0;
  const enHits = sample.match(/\b(hello|hi|hey|please|weather|today|what|where|thanks|thank)\b/gi)?.length || 0;
  const frHits = value.match(/\b(bonjour|merci|aujourd'hui|meteo|météo|s'il vous)\b/gi)?.length || 0;
  if (/[¿¡]/.test(value) && esHits >= 1) return "es";
  if (esHits >= 2 && esHits >= enHits) return "es";
  if (frHits >= 1 && contentWords(value).length >= 3) return "fr";
  if (enHits >= 2) return "en";
  return "";
}

/** A full caller turn, not a place name or a short fragment. */
export function isClearLanguageTurn(text) {
  const words = contentWords(text);
  if (words.length < 3) return false;
  return Boolean(detectCallerLanguage(text));
}

/**
 * Keep the established reply language unless this text is a full turn
 * in a different language. Noise, one odd word, and Castellón do not switch.
 */
export function resolveReplyLanguage(established, text) {
  const current = String(established || "").trim().toLowerCase();
  const detected = detectCallerLanguage(text);
  if (!detected) return current;
  if (!isClearLanguageTurn(text)) return current;
  return detected;
}

export function languageName(code) {
  return NAMES[code] || "";
}

/** Multilingual transcription. No singular `language` field, so nothing is locked to English. */
export function inputTranscription(hint) {
  const code = TRANSCRIPTION_LANGUAGES.includes(hint) ? hint : "";
  const languages = code
    ? [code, ...TRANSCRIPTION_LANGUAGES.filter((item) => item !== code)]
    : [...TRANSCRIPTION_LANGUAGES];
  return {
    model: "gpt-transcribe",
    languages,
    prompt: "Verbatim phone transcript in the language spoken. Do not translate to English. Keep place names intact, including Castellón de la Plana and Кастельон-де-ла-Плана.",
  };
}

export function spokenFailure(name, userText = "", established = "") {
  const weather = /weather|forecast|temperature|clima|tiempo|lluvia|meteo|погод|\brain\b/i.test(`${name} ${userText}`);
  const code = resolveReplyLanguage(established, userText) || established || "en";
  const line = FAILURES[code] || FAILURES.en;
  return weather ? line.weather : line.other;
}

/**
 * Instruction for the latest caller turn. Keeps their words. Does not rewrite
 * a Ukrainian question into an English-only instruction.
 */
export function callerTurnLine(text, established = "") {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const code = resolveReplyLanguage(established, clean) || established || "";
  const name = languageName(code);
  if (!clean) {
    return name
      ? `Reply only in ${name}. Keep that language until the caller speaks a full turn in another language. A place name, noise, or a short fragment is not a switch.`
      : "Reply in the language of the caller's latest full turn. Do not lock the reply to English.";
  }
  const which = name
    ? `Reply only in ${name}. Keep ${name} for the rest of the call unless the caller clearly speaks a full turn in another language. A place name such as Castellón, a tool result, noise, or a short fragment is not a switch.`
    : "Reply in the language of this full turn. Do not switch because of a place name or a fragment.";
  return `${which} Their words, unchanged: ${clean} Do not rewrite that turn into English. Do not answer in a different language.`;
}

export function composeSessionInstructions(instructions, { uiLang = "", callerText = "", established = "" } = {}) {
  const follow = [
    "Language rule (mandatory): Reply in the caller's language. Once that language is clear, keep it for the rest of the call.",
    "Switch only when the caller speaks a full turn in a different language. Do not switch for a place name (Castellón, Castellón de la Plana), a tool result, background noise, one odd word, or a partial transcript.",
    "Do not stay in English after the caller has spoken a full turn in another language. The greeting language applies only before they speak.",
  ].join(" ");
  let next = String(instructions || "")
    .replaceAll("Reply in English.", " ")
    .replaceAll("Reply in Spanish.", " ")
    .replace(/Soft (?:UI )?preference only before the caller speaks:[^.]*\./g, " ")
    .replace(/\n*The caller's latest turn is[\s\S]*$/m, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!next.includes("Language rule (mandatory)")) {
    next = next ? `${next}\n\n${follow}` : follow;
  }
  const caller = String(callerText || "").trim();
  const kept = resolveReplyLanguage(established, caller) || established || "";
  if (caller || kept) return `${next}\n\n${callerTurnLine(caller, kept)}`.trim();
  if (uiLang === "es") return `${next} Soft UI preference only before the caller speaks: Spanish.`;
  if (uiLang === "en") return `${next} Soft UI preference only before the caller speaks: English.`;
  return next;
}

/** Built-in OpenAI Realtime voices. "chloe" is not one of them. */
export const REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

/**
 * Voice value for session.audio.output.voice. "Chloe" is the desk's name for
 * the default voice; the API speaks it with built-in "marin". Sending
 * { id: "chloe" } mints a token but /v1/realtime/calls then times out (504),
 * so every web call ended on "Voice unavailable". Only real custom voice ids
 * (voice_...) are sent as objects.
 */
export function apiVoice(voice) {
  if (voice && typeof voice === "object") {
    const id = String(voice.id || "").trim();
    if (/^voice_/.test(id)) return { id };
    return apiVoice(id);
  }
  const name = String(voice || "").trim().toLowerCase();
  return REALTIME_VOICES.includes(name) ? name : "marin";
}

export function sessionAudioForCaller(audio, voice, _callerText = "") {
  const next = { ...(audio || {}) };
  next.output = { ...(next.output || {}), voice: apiVoice(voice || next.output?.voice) };
  // Do not retarget transcription per turn. Reordering `languages` is a
  // session.update that delays the next audio and can follow a fragment.
  return next;
}

export function applyCallerTurn(session, text, established = "") {
  const base = session?.baseInstructions || session?.instructions || "";
  const callerText = String(text || "").trim();
  const previous = String(established || session?.callerLanguage || "").trim().toLowerCase();
  const language = resolveReplyLanguage(previous, callerText) || previous;
  const instructions = composeSessionInstructions(base, { callerText, established: language });
  return {
    instructions,
    baseInstructions: base,
    language,
    changed: Boolean(language) && language !== previous,
  };
}
