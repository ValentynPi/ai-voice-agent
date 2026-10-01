import { createHash, randomBytes } from "node:crypto";

export function stableSid(prefix, seed) {
  const hex = createHash("sha256").update(String(seed)).digest("hex").slice(0, 32);
  return `${prefix}${hex}`;
}

export function randomSid(prefix) {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function isSid(value, prefix) {
  return new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(String(value || ""));
}

export const DEMO_ACCOUNT_SID = stableSid("AC", "maison-sol-demo-account");
export const DEMO_NUMBER_SID = stableSid("PN", "maison-sol-main");
export const DEMO_APP_SID = stableSid("AP", "maison-sol-voice-app");
export const DEMO_CALL_SID = stableSid("CA", "maison-sol-demo-inbound");
export const DEMO_MISSED_SID = stableSid("CA", "maison-sol-demo-missed");
export const DEMO_RECORDING_SID = stableSid("RE", "maison-sol-demo-recording");
export const DEMO_EVENT_SID = stableSid("NO", "maison-sol-demo-voice-event");

export const DEMO_INVENTORY = [
  {
    phone_number: "+34964000214",
    locality: "Castellón de la Plana",
    region: "Castellón",
    iso_country: "ES",
    sms: false,
    friendly_name: "Maison Sol main",
  },
  {
    phone_number: "+34964011880",
    locality: "Castellón de la Plana",
    region: "Castellón",
    iso_country: "ES",
    sms: true,
  },
  {
    phone_number: "+34964552019",
    locality: "Castellón de la Plana",
    region: "Castellón",
    iso_country: "ES",
    sms: false,
  },
  {
    phone_number: "+34964110042",
    locality: "Benicàssim",
    region: "Castellón",
    iso_country: "ES",
    sms: true,
  },
  {
    phone_number: "+34961004421",
    locality: "Valencia",
    region: "Valencia",
    iso_country: "ES",
    sms: true,
  },
  {
    phone_number: "+34932001844",
    locality: "Barcelona",
    region: "Barcelona",
    iso_country: "ES",
    sms: false,
  },
  {
    phone_number: "+34910022018",
    locality: "Madrid",
    region: "Madrid",
    iso_country: "ES",
    sms: true,
  },
  {
    phone_number: "+97235100010",
    locality: "Tel Aviv",
    region: "Tel Aviv",
    iso_country: "IL",
    sms: true,
  },
  {
    phone_number: "+97235100118",
    locality: "Tel Aviv",
    region: "Tel Aviv",
    iso_country: "IL",
    sms: false,
  },
  {
    phone_number: "+97225520019",
    locality: "Jerusalem",
    region: "Jerusalem",
    iso_country: "IL",
    sms: true,
  },
  {
    phone_number: "+97248550042",
    locality: "Haifa",
    region: "Haifa",
    iso_country: "IL",
    sms: false,
  },
  {
    phone_number: "+97254410021",
    locality: "Tel Aviv",
    region: "Tel Aviv",
    iso_country: "IL",
    sms: true,
  },
  {
    phone_number: "+97286440077",
    locality: "Be'er Sheva",
    region: "Southern",
    iso_country: "IL",
    sms: false,
  },
];
