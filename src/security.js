const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /disregard (your |all |the )?(instructions|rules|guidelines|prompt)/i,
  /forget (your |all |the )?(instructions|rules|guidelines|prompt)/i,
  /ignora (las |todas las |tus )?(instrucciones|reglas)/i,
  /olvida (las |tus )?(instrucciones|reglas)/i,
  /\byou are now\b/i,
  /\b(system|developer) prompt\b/i,
  /\bjailbreak\b/i,
  /\bdo anything now\b/i,
  /\bdeveloper mode\b/i,
  /override (the )?(system|safety|rules)/i,
  /reveal (your |the )?(hidden |system )?(prompt|instructions)/i,
];

const EXFIL = [
  /\bapi[_\s-]?key\b/i,
  /\bsecret(s| key)?\b/i,
  /\bpassword\b/i,
  /\bcredentials?\b/i,
  /\bprocess\.env\b/i,
  /\benvironment variables?\b/i,
  /\bprivate key\b/i,
  /\bcredit card\b/i,
  /\bsocial security\b/i,
  /\bexfiltrat/i,
  /\bdump\b/i,
  /\bexport (all|the|our)\b/i,
  /\bsend (all|the|our) (customer|client|records|data|database)\b/i,
];

const DENY_ARG_KEY = /password|secret|api.?key|token|credential|ssn|credit.?card|dump|exfil/i;

export function sanitizeText(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
}

function decision(allow, summary, detail, reasonCode) {
  return {
    decision: allow ? "allow" : "deny",
    summary,
    detail,
    reasonCode,
  };
}

export function screenInput(text) {
  const clean = sanitizeText(text);
  if (!clean) {
    return decision(false, "Empty message", "Nothing to screen.", "empty");
  }
  if (clean.length > 2000) {
    return decision(false, "Message blocked", "The message is too long.", "length");
  }
  if (INJECTION.some((pattern) => pattern.test(clean))) {
    return decision(
      false,
      "Prompt injection blocked",
      "Matched an instruction-override phrase.",
      "injection",
    );
  }
  if (EXFIL.some((pattern) => pattern.test(clean))) {
    return decision(
      false,
      "Data exfiltration blocked",
      "Matched a request for secrets or a bulk export.",
      "exfil",
    );
  }
  return decision(true, "Prompt check passed", "No injection or exfiltration pattern.", "ok");
}

function argsLookHostile(args) {
  if (args == null) return false;
  if (typeof args !== "object" || Array.isArray(args)) return true;
  const blob = JSON.stringify(args);
  if (blob.length > 2000) return true;
  if (EXFIL.some((pattern) => pattern.test(blob))) return true;
  for (const [key, value] of Object.entries(args)) {
    if (DENY_ARG_KEY.test(key)) return true;
    if (typeof value === "string" && DENY_ARG_KEY.test(value) && value.length < 40) return true;
  }
  return false;
}

export function authorizeTool(name, args, isRegistered) {
  if (!isRegistered) {
    return decision(
      false,
      "Tool blocked",
      "Tool is not registered on the allowlist.",
      "allowlist",
    );
  }
  if (argsLookHostile(args)) {
    return decision(
      false,
      "Tool blocked",
      "Arguments looked like a secret or export request.",
      "args",
    );
  }
  return decision(true, "Tool authorized", `${name} is allowlisted.`, "ok");
}
