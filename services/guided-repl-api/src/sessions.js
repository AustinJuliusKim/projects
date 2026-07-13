/**
 * Opaque session tokens: the browser holds the random token in an httpOnly
 * cookie; the database stores only its sha256 hash (a DB leak reveals no
 * usable tokens).
 */

import crypto from "node:crypto";

export const SESSION_COOKIE = "gr_session";

/** @returns {string} a fresh opaque session token */
export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** @param {string} token @returns {string} sha256 hex of the token */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * @param {number} ttlDays
 * @returns {import("@fastify/cookie").CookieSerializeOptions}
 */
export function cookieOptions(ttlDays) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ttlDays * 24 * 60 * 60,
  };
}

/** @param {number} ttlDays @returns {Date} */
export function sessionExpiry(ttlDays) {
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
}
