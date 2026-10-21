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

const PLACE_NAME = /castell[oó]n(?:\s+de\s+la\s+plana)?|кастель[ойой]н\w*(?:-де-ла-плана)?|кастельйон\w*(?:-де-ла-плана)?/gi;

/** Place names are not evidence of a language. */
export function withoutPlaceNames(text) {
  return String(text || "").replace(PLACE_NAME, " ");
}

function contentWords(text) {
  return withoutPlaceNames(text).match(/\p{L}{2,}/gu) || [];
}

const UK_WORDS = /(?:^|[^\p{L}])(що|як|яка|який|яке|які|чи|ти|ви|мені|тобі|вмієш|можеш|будь|ласка|привіт|вітаю|дякую|сьогодні|завтра|скажи|скажіть|погода|зараз|де|коли|так|ні|добре|розкажи|розкажіть)(?=$|[^\p{L}])/giu;
const RU_WORDS = /(?:^|[^\p{L}])(что|как|какая|какой|какое|ты|мне|тебе|умеешь|можешь|пожалуйста|привет|здравствуйте|спасибо|сегодня|сейчас|где|когда|да|нет|хорошо|это|расскажи|расскажите)(?=$|[^\p{L}])/giu;

/** Ukrainian evidence: і/ї/є/ґ letters and common Ukrainian-only words. */
function ukrainianScore(value) {
  return (value.match(/[іїєґІЇЄҐ]/g) || []).length * 2 + (value.match(UK_WORDS) || []).length;
}

/** Russian evidence: ы/э/ъ/ё letters and common Russian-only words. */
function russianScore(value) {
  return (value.match(/[ыэъёЫЭЪЁ]/g) || []).length * 2 + (value.match(RU_WORDS) || []).length;
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
    const uk = ukrainianScore(value);
    const ru = russianScore(value);
    if (uk > ru) return "uk";
    if (ru > uk) return "ru";
    // No Ukrainian or Russian evidence either way: do not guess (a guess flipped
    // Ukrainian callers to Russian). The reply follows the caller's own words.
    return "";
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
  const detected = detectCallerLanguage(text);
  if (!detected) return false;
  const words = contentWords(text);
  // "Яка погода в Кастельон-де-ла-Плана?" strips the city to two words — still clear.
  // English keeps the three-word bar so "hi thanks" noise cannot lock the call.
  if (detected === "en") return words.length >= 3;
  return words.length >= 2;
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
    "Language rule (mandatory): Reply in the caller's language. Match their spoken audio immediately — do not wait for a transcript label.",
    "Once that language is clear, keep it for the rest of the call.",
    "Switch only when the caller speaks a full turn in a different language. Do not switch for a place name (Castellón, Castellón de la Plana), a tool result, background noise, one odd word, or a partial transcript.",
    "Do not stay in English after the caller has spoken a full turn in another language. English Bot task text, Model notes, UI labels, greetings, or tool JSON must never force an English reply. The greeting language applies only before they speak.",
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
  // The desk UI language is the operator's screen, not the caller: never hint it.
  void uiLang;
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


/**
 * Transcripts the speech model invents from silence, room noise, keyboard, a
 * cough or TV murmur. Whole-turn matches only (after trimming punctuation).
 */
const HALLUCINATIONS = [
  "thank you", "thanks", "thank you for watching", "thanks for watching", "you", "bye", "okay", "ok",
  "so", "the end", "subtitles by the amara.org community", "please subscribe",
  "продолжение следует", "субтитры", "субтитры сделал dimatorzok", "субтитры создавал dimatorzok",
  "редактор субтитров", "спасибо за просмотр", "дякую за перегляд", "это место",
  "gracias", "gracias por ver", "subtítulos", "subtítulos realizados por la comunidad de amara.org",
  "merci", "sous-titres", "ご視聴ありがとうございました",
];
const FILLERS = /^(?:u+h+|u+m+|h+m+|m+h*|a+h+|e+h+|o+h+|е+|э+|м+|м+м+|а+|ее+|эм+|хм+|ага?|угу|ммм+|ой|ах)$/iu;

/**
 * "noise" — never answer it (empty, punctuation, <2 letters, filler,
 * known hallucination). "speech" — a real caller turn.
 */
export function classifyCallerTranscript(text) {
  const raw = String(text || "").trim();
  const letters = raw.match(/\p{L}/gu) || [];
  if (letters.length < 2) return "noise";
  const plain = raw.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (!plain) return "noise";
  if (HALLUCINATIONS.includes(plain)) return "noise";
  if (/^(?:субтитры|subtitles|sous-titres|subtítulos)\b/.test(plain)) return "noise";
  const words = plain.split(" ");
  if (words.every((word) => FILLERS.test(word))) return "noise";
  return "speech";
}

/** The hard per-reply language line built from the caller's own transcript. */
export function replyLanguageLine(code, text = "") {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const name = languageName(code);
  const words = clean ? ` The caller said: "${clean}".` : "";
  if (name) {
    return `Reply ONLY in ${name}. Every word of this reply must be ${name}, even though the greeting, the Bot task, and tool data are English.${words}`;
  }
  return `Reply ONLY in the language the caller used in their words below, not English unless those words are English.${words}`;
}
