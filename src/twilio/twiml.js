/**
 * Voice webhook TwiML.
 * When streamUrl is set, Twilio opens a bidirectional Media Stream to the Agents brain.
 * Without a stream URL (misconfigured PUBLIC_URL), fall back to a short Say so the call still answers.
 */
export function voiceTwiml({ streamUrl, agentId, callSid } = {}) {
  if (!streamUrl) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">Maison Sol cannot start a Media Stream. Set PUBLIC_URL or FLY_APP_NAME on the Agents host so the brain can advertise a WebSocket URL.</Say>
</Response>`;
  }

  const params = [];
  if (agentId) {
    params.push(`      <Parameter name="agentId" value="${escapeXml(agentId)}" />`);
  }
  if (callSid) {
    params.push(`      <Parameter name="callSid" value="${escapeXml(callSid)}" />`);
  }
  const paramBlock = params.length ? `\n${params.join("\n")}\n    ` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">${paramBlock}</Stream>
  </Connect>
</Response>`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
