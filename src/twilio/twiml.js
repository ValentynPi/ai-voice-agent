export function voiceTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">Thank you for calling Maison Sol. This webhook answers with TwiML. Browser test calls use OpenAI Realtime until a Media Streams connection is added.</Say>
</Response>`;
}
