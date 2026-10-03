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

export function detectCallerLanguage(text) {
  const value = String(text || "");
  if (/[\u0590-\u05FF]/.test(value)) return "he";
  if (/[\u0600-\u06FF]/.test(value)) return "ar";
  if (/[\u0400-\u04FF]/.test(value)) {
    if (/[іїєґІЇЄҐ]/.test(value) || /привіт|будь ласка|сьогодні|скажи|дякую|яка|який|яке|які|мені/i.test(value)) {
      return "uk";
    }
    return "ru";
  }
  const sample = value.normalize("NFD").replace(/\p{M}/gu, "");
  if (/[¿¡]/.test(value) || /\b(hola|gracias|por favor|tiempo|clima|que|qué|como|cómo|donde|dónde|hoy|buenos|buenas)\b/i.test(sample)) {
    return "es";
  }
  if (/\b(bonjour|merci|aujourd'hui|meteo|météo|s'il vous)\b/i.test(value)) return "fr";
  if (/\b(hello|hi|hey|please|weather|today|what|where|thanks|thank)\b/i.test(sample)) return "en";
  return "";
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

export function spokenFailure(name, userText = "") {
  const weather = /weather|forecast|temperature|clima|tiempo|lluvia|meteo|погод|\brain\b/i.test(`${name} ${userText}`);
  const code = detectCallerLanguage(userText) || "en";
  const line = FAILURES[code] || FAILURES.en;
  return weather ? line.weather : line.other;
}

/**
 * Instruction for the latest caller turn. Keeps their words. Does not rewrite
 * a Ukrainian question into an English-only instruction.
 */
export function callerTurnLine(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "Reply in the language of the caller's latest spoken turn. Do not lock the reply to English.";
  }
  const code = detectCallerLanguage(clean);
  const name = languageName(code);
  const which = name
    ? `The caller's latest turn is ${name}. Reply only in ${name}.`
    : "Reply in the language of this turn, not a previous one.";
  return `${which} Their words, unchanged: ${clean} Do not rewrite that turn into English. Do not answer in a different language.`;
}

export function composeSessionInstructions(instructions, { uiLang = "", callerText = "" } = {}) {
  const follow = [
    "Language rule (mandatory): Always reply in the language of the caller's most recent spoken turn.",
    "If the caller switches language mid-call, switch immediately. Do not stay in English after they speak another language.",
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
  if (caller) return `${next}\n\n${callerTurnLine(caller)}`.trim();
  if (uiLang === "es") return `${next} Soft UI preference only before the caller speaks: Spanish.`;
  if (uiLang === "en") return `${next} Soft UI preference only before the caller speaks: English.`;
  return next;
}

export function sessionAudioForCaller(audio, voice, callerText = "") {
  const next = { ...(audio || {}) };
  next.output = { ...(next.output || {}), voice: voice || next.output?.voice || "marin" };
  next.input = { ...(next.input || {}) };
  const current = next.input.transcription;
  const hint = detectCallerLanguage(callerText);
  // Keep a server fallback that omitted `languages` (the API rejected multilingual).
  // Otherwise turn multilingual transcription on, with the latest turn first.
  if (!current || current.model === "gpt-transcribe" || Array.isArray(current.languages)) {
    next.input.transcription = inputTranscription(hint);
  } else if (hint) {
    next.input.transcription = { model: current.model, language: hint };
  } else {
    const { language, ...rest } = current;
    next.input.transcription = rest;
  }
  return next;
}

export function applyCallerTurn(session, text) {
  const base = session?.baseInstructions || session?.instructions || "";
  const callerText = String(text || "").trim();
  const instructions = composeSessionInstructions(base, { callerText });
  const audio = sessionAudioForCaller(session?.audio, session?.audio?.output?.voice, callerText);
  return {
    instructions,
    audio,
    baseInstructions: base,
    language: detectCallerLanguage(callerText),
  };
}
