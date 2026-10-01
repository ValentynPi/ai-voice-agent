import {
  DEMO_ACCOUNT_SID,
  DEMO_APP_SID,
  DEMO_CALL_SID,
  DEMO_EVENT_SID,
  DEMO_INVENTORY,
  DEMO_MISSED_SID,
  DEMO_NUMBER_SID,
  DEMO_RECORDING_SID,
} from "./ids.js";

const VOICE_PATH = "/twilio/voice";
const STATUS_PATH = "/twilio/status";

export function ensureTwilioTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS twilio_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_sid TEXT NOT NULL,
      friendly_name TEXT NOT NULL,
      saved_account_sid TEXT,
      auth_token TEXT,
      api_key_sid TEXT,
      api_key_secret TEXT,
      date_created TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twilio_numbers (
      sid TEXT PRIMARY KEY,
      account_sid TEXT NOT NULL,
      phone_number TEXT NOT NULL UNIQUE,
      friendly_name TEXT NOT NULL,
      voice_url TEXT,
      voice_method TEXT NOT NULL DEFAULT 'POST',
      voice_fallback_url TEXT,
      status_callback TEXT,
      status_callback_method TEXT NOT NULL DEFAULT 'POST',
      sms_url TEXT,
      sms_method TEXT NOT NULL DEFAULT 'POST',
      capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in-use',
      demo INTEGER NOT NULL DEFAULT 1,
      date_created TEXT NOT NULL,
      date_updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twilio_calls (
      sid TEXT PRIMARY KEY,
      account_sid TEXT NOT NULL,
      parent_call_sid TEXT,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      phone_number_sid TEXT,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      duration INTEGER,
      recording_url TEXT,
      recording_sid TEXT,
      price TEXT,
      local_call_id TEXT,
      media TEXT,
      annotation TEXT,
      demo INTEGER NOT NULL DEFAULT 1,
      date_created TEXT NOT NULL,
      date_updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twilio_calls_start ON twilio_calls (start_time);
    CREATE TABLE IF NOT EXISTS twilio_apps (
      sid TEXT PRIMARY KEY,
      account_sid TEXT NOT NULL,
      friendly_name TEXT NOT NULL,
      voice_url TEXT,
      voice_method TEXT NOT NULL DEFAULT 'POST',
      status_callback TEXT,
      status_callback_method TEXT NOT NULL DEFAULT 'POST',
      sms_url TEXT,
      sms_method TEXT NOT NULL DEFAULT 'POST',
      demo INTEGER NOT NULL DEFAULT 1,
      date_created TEXT NOT NULL,
      date_updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twilio_events (
      sid TEXT PRIMARY KEY,
      account_sid TEXT NOT NULL,
      request_method TEXT NOT NULL,
      request_url TEXT NOT NULL,
      call_sid TEXT,
      request_json TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT,
      log_level TEXT NOT NULL,
      message TEXT NOT NULL,
      signature TEXT NOT NULL,
      date_created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twilio_events_created ON twilio_events (date_created);
  `);
  seedTwilio(database);
}

function seedTwilio(database) {
  const seeded = database.prepare("SELECT value FROM meta WHERE key = 'twilio_seeded'").get();
  if (seeded) return;
  const now = new Date();
  const created = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 12).toISOString();
  const inboundStart = new Date(now.getTime() - 1000 * 60 * 42).toISOString();
  const inboundEnd = new Date(now.getTime() - 1000 * 60 * 40).toISOString();
  const missedStart = new Date(now.getTime() - 1000 * 60 * 60 * 5).toISOString();
  const missedEnd = new Date(now.getTime() - 1000 * 60 * 60 * 5 + 18000).toISOString();
  const main = DEMO_INVENTORY[0];
  const recordingUrl = `/api/twilio/v1/Accounts/${DEMO_ACCOUNT_SID}/Calls/${DEMO_CALL_SID}/Recordings/${DEMO_RECORDING_SID}`;
  database.exec("BEGIN");
  try {
    database.prepare(`
      INSERT INTO twilio_account (
        id, account_sid, friendly_name, saved_account_sid, auth_token, api_key_sid, api_key_secret,
        date_created, updated_at
      ) VALUES (1, ?, 'Maison Sol', NULL, NULL, NULL, NULL, ?, ?)
    `).run(DEMO_ACCOUNT_SID, created, created);
    database.prepare(`
      INSERT INTO twilio_numbers (
        sid, account_sid, phone_number, friendly_name, voice_url, voice_method, voice_fallback_url,
        status_callback, status_callback_method, sms_url, sms_method, capabilities_json, status, demo,
        date_created, date_updated
      ) VALUES (?, ?, ?, ?, ?, 'POST', NULL, ?, 'POST', NULL, 'POST', ?, 'in-use', 1, ?, ?)
    `).run(
      DEMO_NUMBER_SID,
      DEMO_ACCOUNT_SID,
      main.phone_number,
      main.friendly_name,
      VOICE_PATH,
      STATUS_PATH,
      JSON.stringify({ voice: true, sms: false, mms: false }),
      created,
      created,
    );
    database.prepare(`
      INSERT INTO twilio_apps (
        sid, account_sid, friendly_name, voice_url, voice_method, status_callback,
        status_callback_method, sms_url, sms_method, demo, date_created, date_updated
      ) VALUES (?, ?, 'Maison Sol Voice', ?, 'POST', ?, 'POST', NULL, 'POST', 1, ?, ?)
    `).run(DEMO_APP_SID, DEMO_ACCOUNT_SID, VOICE_PATH, STATUS_PATH, created, created);
    const insertCall = database.prepare(`
      INSERT INTO twilio_calls (
        sid, account_sid, parent_call_sid, from_number, to_number, phone_number_sid, direction, status,
        start_time, end_time, duration, recording_url, recording_sid, price, local_call_id, media,
        annotation, demo, date_created, date_updated
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?)
    `);
    insertCall.run(
      DEMO_CALL_SID,
      DEMO_ACCOUNT_SID,
      "+34611222333",
      main.phone_number,
      DEMO_NUMBER_SID,
      "inbound",
      "completed",
      inboundStart,
      inboundEnd,
      86,
      recordingUrl,
      DEMO_RECORDING_SID,
      "twiml",
      "Demo inbound call. The recording URL is a stub with no audio file.",
      inboundStart,
      inboundEnd,
    );
    insertCall.run(
      DEMO_MISSED_SID,
      DEMO_ACCOUNT_SID,
      main.phone_number,
      "+34600999888",
      DEMO_NUMBER_SID,
      "outbound",
      "no-answer",
      missedStart,
      missedEnd,
      0,
      null,
      null,
      "twiml",
      "Demo outbound attempt. No carrier call was placed.",
      missedStart,
      missedEnd,
    );
    database.prepare(`
      INSERT INTO twilio_events (
        sid, account_sid, request_method, request_url, call_sid, request_json, response_status,
        response_body, log_level, message, signature, date_created
      ) VALUES (?, ?, 'POST', ?, ?, ?, 200, ?, 'info', ?, 'absent', ?)
    `).run(
      DEMO_EVENT_SID,
      DEMO_ACCOUNT_SID,
      VOICE_PATH,
      DEMO_CALL_SID,
      JSON.stringify({
        CallSid: DEMO_CALL_SID,
        From: "+34611222333",
        To: main.phone_number,
        CallStatus: "ringing",
        Direction: "inbound",
        AccountSid: DEMO_ACCOUNT_SID,
      }),
      voiceTwimlBody(),
      "Voice webhook answered with TwiML",
      inboundStart,
    );
    database.prepare("INSERT INTO meta (key, value) VALUES ('twilio_seeded', '1')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function voiceTwimlBody() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">Thank you for calling Maison Sol. This webhook answers with TwiML. Browser test calls use OpenAI Realtime until a Media Streams connection is added.</Say>
</Response>`;
}
