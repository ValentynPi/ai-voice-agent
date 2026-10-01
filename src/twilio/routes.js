import { Router } from "express";
import { httpError, stripSecrets } from "./http.js";
import {
  accountView,
  buyPhoneNumber,
  changeAppResource,
  changePhoneNumber,
  createAppResource,
  getAppResource,
  getCallResource,
  getEventResource,
  getPhoneNumber,
  listAppResources,
  listCallResources,
  listEventResources,
  listPhoneNumbers,
  listRecordingResources,
  removeCredentials,
  searchNumbers,
  updateCredentials,
} from "./service.js";
import { statusWebhook, voiceWebhook } from "./webhooks.js";

function queryValue(req, ...names) {
  for (const name of names) {
    const value = req.query[name];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function pageSize(req) {
  return queryValue(req, "PageSize", "pageSize");
}

function callQuery(req) {
  return {
    status: queryValue(req, "Status", "status").toLowerCase(),
    from: queryValue(req, "From", "from"),
    to: queryValue(req, "To", "to"),
    direction: queryValue(req, "Direction", "direction").toLowerCase(),
    pageSize: pageSize(req),
  };
}

function readBody(req) {
  const body = req.body || {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (body[key] != null && body[key] !== "") return body[key];
    }
    return undefined;
  };
  return {
    phoneNumber: pick("phone_number", "PhoneNumber"),
    friendlyName: pick("friendly_name", "FriendlyName"),
    voiceUrl: pick("voice_url", "VoiceUrl"),
    voiceMethod: pick("voice_method", "VoiceMethod"),
    statusCallback: pick("status_callback", "StatusCallback"),
    statusCallbackMethod: pick("status_callback_method", "StatusCallbackMethod"),
    confirmPurchase: body.confirm_purchase === true || body.confirm_purchase === "true",
    accountSid: pick("account_sid", "AccountSid"),
    authToken: pick("auth_token", "AuthToken"),
    apiKeySid: pick("api_key_sid", "ApiKeySid"),
    apiKeySecret: pick("api_key_secret", "ApiKeySecret"),
  };
}

function present(input, { partial } = {}) {
  const body = readBody({ body: input });
  const out = {};
  const assign = (key, value) => {
    if (value !== undefined) out[key] = value;
  };
  if (!partial || input.friendly_name != null || input.FriendlyName != null) assign("friendlyName", body.friendlyName);
  if (!partial || input.voice_url != null || input.VoiceUrl != null) assign("voiceUrl", body.voiceUrl);
  if (!partial || input.voice_method != null || input.VoiceMethod != null) assign("voiceMethod", body.voiceMethod);
  if (!partial || input.status_callback != null || input.StatusCallback != null) assign("statusCallback", body.statusCallback);
  if (!partial || input.status_callback_method != null || input.StatusCallbackMethod != null) {
    assign("statusCallbackMethod", body.statusCallbackMethod);
  }
  return out;
}

export function mountTwilio(app) {
  app.post("/twilio/voice", voiceWebhook);
  app.get("/twilio/voice", voiceWebhook);
  app.post("/twilio/status", statusWebhook);
  app.get("/twilio/status", statusWebhook);

  const router = Router();
  router.use((req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => send(stripSecrets(body));
    next();
  });

  router.get("/account", (req, res) => {
    res.json(accountView(req));
  });

  router.put("/account/credentials", (req, res, next) => {
    try {
      const body = readBody(req);
      const input = {};
      if (body.accountSid !== undefined) input.savedAccountSid = body.accountSid;
      if (body.authToken) input.authToken = body.authToken;
      if (body.apiKeySid !== undefined) input.apiKeySid = body.apiKeySid;
      if (body.apiKeySecret) input.apiKeySecret = body.apiKeySecret;
      updateCredentials(input);
      res.json(accountView(req));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/account/credentials", (req, res) => {
    removeCredentials();
    res.json(accountView(req));
  });

  router.get("/Accounts/:sid/IncomingPhoneNumbers", async (req, res, next) => {
    try {
      res.json(await listPhoneNumbers(req.params.sid, {
        phoneNumber: queryValue(req, "PhoneNumber", "phoneNumber"),
        friendlyName: queryValue(req, "FriendlyName", "friendlyName"),
        pageSize: pageSize(req),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/Accounts/:sid/IncomingPhoneNumbers", async (req, res, next) => {
    try {
      const body = readBody(req);
      if (!body.phoneNumber) throw httpError(400, "phone_number is required");
      const number = await buyPhoneNumber(req.params.sid, body);
      res.status(201).json(number);
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/IncomingPhoneNumbers/:numberSid", async (req, res, next) => {
    try {
      res.json(await getPhoneNumber(req.params.sid, req.params.numberSid));
    } catch (error) {
      next(error);
    }
  });

  router.post("/Accounts/:sid/IncomingPhoneNumbers/:numberSid", async (req, res, next) => {
    try {
      res.json(await changePhoneNumber(req.params.sid, req.params.numberSid, present(req.body || {}, { partial: true })));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/AvailablePhoneNumbers/:country/Local", async (req, res, next) => {
    try {
      const sms = queryValue(req, "SmsEnabled", "sms");
      res.json(await searchNumbers(req.params.sid, req.params.country, {
        contains: queryValue(req, "Contains", "contains"),
        sms: sms === "true" || sms === "1",
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Calls", async (req, res, next) => {
    try {
      res.json(await listCallResources(req.params.sid, callQuery(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Calls/:callSid/Recordings", async (req, res, next) => {
    try {
      res.json(await listRecordingResources(req.params.sid, req.params.callSid));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Calls/:callSid/Recordings/:recordingSid", async (req, res, next) => {
    try {
      const page = await listRecordingResources(req.params.sid, req.params.callSid);
      const found = page.recordings.find((item) => item.sid === req.params.recordingSid);
      if (!found) throw httpError(404, "The requested resource was not found");
      res.json(found);
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Calls/:callSid", async (req, res, next) => {
    try {
      res.json(await getCallResource(req.params.sid, req.params.callSid));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Applications", async (req, res, next) => {
    try {
      res.json(await listAppResources(req.params.sid));
    } catch (error) {
      next(error);
    }
  });

  router.post("/Accounts/:sid/Applications", async (req, res, next) => {
    try {
      const app = await createAppResource(req.params.sid, present(req.body || {}));
      res.status(201).json(app);
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Applications/:appSid", async (req, res, next) => {
    try {
      res.json(await getAppResource(req.params.sid, req.params.appSid));
    } catch (error) {
      next(error);
    }
  });

  router.post("/Accounts/:sid/Applications/:appSid", async (req, res, next) => {
    try {
      res.json(await changeAppResource(req.params.sid, req.params.appSid, present(req.body || {}, { partial: true })));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Monitor/Events", (req, res, next) => {
    try {
      res.json(listEventResources(req.params.sid));
    } catch (error) {
      next(error);
    }
  });

  router.get("/Accounts/:sid/Monitor/Events/:eventSid", (req, res, next) => {
    try {
      res.json(getEventResource(req.params.sid, req.params.eventSid));
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/twilio/v1", router);
}
