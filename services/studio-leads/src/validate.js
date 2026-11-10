export const BUSINESS_TYPES = ["restaurant", "salon-booking", "retail", "professional-office", "other"];
export const CITIES = ["glendale", "pasadena", "burbank", "sfv", "la-other", "other"];
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(v) {
  return typeof v === "string" ? v.replace(CONTROL_RE, "").trim() : null;
}

function normalizeWebsite(raw) {
  let s = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/]*\.[^/:]*:\d+/.test(s)) return null;
    s = `https://${s}`;
  }
  if (s.length > 200) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.includes(".")) return null;
  return s;
}

export function validateLead(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: { body: "must be an object" } };
  }
  const errors = {};

  const email = clean(body.email)?.toLowerCase();
  if (!email) errors.email = "required";
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = "invalid";

  const firstName = clean(body.firstName);
  if (!firstName) errors.firstName = "required";
  else if (firstName.length > 80) errors.firstName = "too long (max 80)";

  const businessType = clean(body.businessType);
  if (!businessType) errors.businessType = "required";
  else if (!BUSINESS_TYPES.includes(businessType)) errors.businessType = "invalid choice";

  const businessName = clean(body.businessName);
  if (!businessName) errors.businessName = "required";
  else if (businessName.length > 120) errors.businessName = "too long (max 120)";

  let website;
  if (body.website !== undefined && body.website !== null && body.website !== "") {
    const raw = clean(body.website);
    if (raw === null) errors.website = "must be a string";
    else if (raw) {
      website = normalizeWebsite(raw);
      if (!website) errors.website = "must be an http(s) URL up to 200 characters";
    }
  }

  const city = clean(body.city);
  if (!city) errors.city = "required";
  else if (!CITIES.includes(city)) errors.city = "invalid choice";

  if (body.consent !== true) errors.consent = "consent is required";

  let utm;
  if (body.utm !== undefined && body.utm !== null) {
    if (typeof body.utm !== "object" || Array.isArray(body.utm)) {
      errors.utm = "must be an object";
    } else {
      utm = {};
      for (const k of UTM_KEYS) {
        const v = body.utm[k];
        if (v === undefined || v === null || v === "") continue;
        const c = clean(v);
        if (c === null || c.length > 100) errors.utm = `${k} must be a string up to 100 characters`;
        else if (c) utm[k] = c;
      }
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  const lead = { email, firstName, businessType, businessName, city, consent: true };
  if (website) lead.website = website;
  if (utm && Object.keys(utm).length) lead.utm = utm;
  return { ok: true, lead };
}
