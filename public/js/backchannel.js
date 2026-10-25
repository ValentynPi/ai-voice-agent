/**
 * Backchannels: short "I'm listening" sounds a caller makes while the agent
 * talks ("yeah", "ok", "mhm", "ага", "угу", "так", "да", "ну", "sí", "vale"),
 * alone, repeated ("yeah yeah", "ага-ага", "okay okay"), mixed ("так, так,
 * добре") or with punctuation ("Yeah.", "Ага!", "Ok?").
 *
 * Shared by the browser dialers and the Twilio bridge (via realtime-turn.js).
 * A backchannel-only transcript must never stop, cancel or truncate the reply
 * that is playing, and never start a new response while the agent speaks.
 * Stop words ("стоп", "зачекайте", "wait", "espera", "stop") are never
 * backchannels, and any real word ("yeah, what about tomorrow", "а завтра?")
 * makes it a real turn.
 */

/** Single-token backchannels (lowercase, no punctuation). */
export const BACKCHANNEL_WORDS = new Set([
  // Ukrainian
  "ага", "угу", "так", "аха", "ну", "ок", "окей", "окей", "о'кей", "добре", "ясно", "зрозуміло", "звісно", "авжеж",
  "чудово", "гаразд", "еге", "атож", "aга",
  // Russian
  "да", "ага", "угу", "понятно", "хорошо", "ладно", "конечно", "ясненько", "отлично",
  // English
  "yeah", "yea", "yes", "yep", "yup", "ya", "ok", "okay", "okey", "k", "kay", "mhm", "mm", "mmm", "hmm", "mm-hmm", "mmhmm",
  "uh-huh", "uhhuh", "uhuh", "aha", "ah", "oh", "right", "sure", "cool", "nice", "alright", "great", "gotcha", "fine",
  "exactly", "indeed", "true", "totally", "absolutely", "perfect",
  // Spanish
  "sí", "si", "vale", "claro", "bueno", "ya", "ajá", "aja", "vale", "perfecto", "exacto", "bien", "venga", "eso",
  // French / German (agents also take these callers)
  "oui", "ouais", "d'accord", "ja", "genau", "gut",
]);

/** Two-word backchannels. */
export const BACKCHANNEL_PHRASES = new Set([
  "uh huh", "mm hmm", "i see", "got it", "all right", "of course", "sounds good", "that's right", "fair enough",
  "makes sense", "oh okay", "oh ok", "oh yeah", "ну да", "ну так", "я понял", "я поняв", "я зрозумів", "я зрозуміла",
  "я поняла", "ah vale", "ah ya", "muy bien", "está bien", "esta bien",
]);

/** Hesitation sounds: never interrupt alone, carry no meaning. */
export const FILLER_TOKEN = /^(?:u+h+|u+m+|h+m+|m+h*m*|a+h+|e+h+|o+h+|е+|э+|м+|а+|ее+|эм+|хм+|ммм+|ой|ах|ох|эх)$/iu;

/** Explicit stop / hold words: always interrupt, even alone. */
export const STOP_WORD = /^(?:стоп|стій|стоп-стоп|зачекай(?:те)?|почекай(?:те)?|підожди|подожди(?:те)?|погоди(?:те)?|хвилинку|хвилиночку|секунду|секундочку|постривай(?:те)?|stop|wait|hold|espera|espere|para|pare|attends|halt|warte)$/iu;
export const STOP_PHRASE = /\b(?:hold on|un momento|wait a (?:second|moment|minute)|one (?:second|moment)|одну секунду|одну хвилину)\b/iu;

/** Lowercased words of a transcript; hyphens split repeats ("ага-ага"). */
export function transcriptTokens(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .toLowerCase()
    .replace(/[’`ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/[\s-]+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** "yeahhh" -> "yeah", "okaaay" -> "okay", "агааа" -> "ага", "ммм" stays a filler. */
function squeeze(word) {
  return word.replace(/(\p{L})\1{2,}/gu, "$1");
}

function isBackchannelWord(word) {
  if (BACKCHANNEL_WORDS.has(word)) return true;
  const short = squeeze(word);
  if (BACKCHANNEL_WORDS.has(short)) return true;
  // Elongated forms whose doubled letter is meaningful: "yeahh", "okk", "mhmm".
  return BACKCHANNEL_WORDS.has(short.replace(/(\p{L})\1/gu, "$1"));
}

export function isStopWord(text) {
  const words = transcriptTokens(text);
  return words.some((w) => STOP_WORD.test(w)) || STOP_PHRASE.test(String(text || "").toLowerCase());
}

/** At most this many tokens: a long run of "yes" is still "yes", a paragraph is not. */
export const BACKCHANNEL_MAX_TOKENS = 8;

/**
 * True when the transcript is only backchannel (and filler) tokens, in any
 * combination or repeat, short, with at least one real backchannel word.
 */
export function isBackchannel(text) {
  const words = transcriptTokens(text);
  if (!words.length || words.length > BACKCHANNEL_MAX_TOKENS) return false;
  if (isStopWord(text)) return false;
  let sawBackchannel = false;
  for (let i = 0; i < words.length; i += 1) {
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    if (pair && BACKCHANNEL_PHRASES.has(pair)) {
      sawBackchannel = true;
      i += 1;
      continue;
    }
    if (isBackchannelWord(words[i])) {
      sawBackchannel = true;
      continue;
    }
    if (FILLER_TOKEN.test(words[i])) continue;
    return false;
  }
  return sawBackchannel;
}
