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
    sms: false,
    friendly_name: "Maison Sol main",
  },
  {
    phone_number: "+34964011880",
    locality: "Castellón de la Plana",
    region: "Castellón",
    sms: true,
  },
  {
    phone_number: "+34964552019",
    locality: "Castellón de la Plana",
    region: "Castellón",
    sms: false,
  },
  {
    phone_number: "+34964110042",
    locality: "Benicàssim",
    region: "Castellón",
    sms: true,
  },
  {
    phone_number: "+34961004421",
    locality: "Valencia",
    region: "Valencia",
    sms: true,
  },
  {
    phone_number: "+34932001844",
    locality: "Barcelona",
    region: "Barcelona",
    sms: false,
  },
  {
    phone_number: "+34910022018",
    locality: "Madrid",
    region: "Madrid",
    sms: true,
  },
];
