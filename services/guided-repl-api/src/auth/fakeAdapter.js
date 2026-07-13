/**
 * Deterministic in-memory auth adapter for tests and local dev (no email,
 * no network). A token hash of `fake-<email>` always verifies to a stable
 * uuid derived from the email.
 */

import crypto from "node:crypto";

/** @param {string} email @returns {string} stable uuid-shaped id */
export function fakeAuthUid(email) {
  const hex = crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @returns {import("./adapter.js").AuthAdapter & {issued: Array<{email: string, redirectTo: string, tokenHash: string}>}}
 */
export function createFakeAdapter() {
  const issued = [];
  return {
    issued,
    async issueMagicLink(email, redirectTo) {
      issued.push({ email, redirectTo, tokenHash: `fake-${email}` });
    },
    async verifyToken(tokenHash, _type) {
      if (typeof tokenHash !== "string" || !tokenHash.startsWith("fake-")) return null;
      const email = tokenHash.slice("fake-".length);
      if (!email.includes("@")) return null;
      return { id: fakeAuthUid(email), email };
    },
  };
}
