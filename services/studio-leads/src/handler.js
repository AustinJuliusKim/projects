import { validateLead } from "./validate.js";

const MAX_BODY_BYTES = 8 * 1024;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export function createHandler({ saveLead, sendWelcome, config = {}, now = () => new Date() }) {
  return async function handler(event) {
    let raw = event?.body ?? "";
    if (event?.isBase64Encoded && raw) raw = Buffer.from(raw, "base64").toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const hp = body.company;
      if (hp !== undefined && hp !== null && String(hp).trim() !== "") return json(200, { ok: true });
    }

    const result = validateLead(body);
    if (!result.ok) return json(400, { error: "invalid", fields: result.errors });

    const ts = now().toISOString();
    const lead = { ...result.lead, createdAt: ts, updatedAt: ts };

    try {
      await saveLead(lead);
    } catch (err) {
      console.error("saveLead failed", { name: err?.name, message: err?.message });
      return json(500, { error: "server_error" });
    }

    if (config.sendWelcome === true) {
      try {
        await sendWelcome(lead);
      } catch (err) {
        console.error("sendWelcome failed", { name: err?.name, message: err?.message });
      }
    }
    return json(201, { ok: true });
  };
}
