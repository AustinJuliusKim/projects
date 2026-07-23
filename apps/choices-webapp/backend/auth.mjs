// Optional Cognito ID-token verification. Guests never send a token; a
// present-but-invalid token is a hard 401 (never silently downgraded to
// guest, or a broken client would corrupt seat->user links).
import { CognitoJwtVerifier } from "aws-jwt-verify";

let verifier = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.USER_POOL_ID,
      clientId: process.env.USER_POOL_CLIENT_ID,
      tokenUse: "id",
    });
  }
  return verifier;
}

// Returns { sub, email, name } or null when no token was sent.
// Throws on a bad/expired token or when auth isn't configured on this stack.
export async function verifyIdToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const token = authorizationHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  if (!process.env.USER_POOL_ID || !process.env.USER_POOL_CLIENT_ID) {
    throw new AuthError("Accounts are not enabled on this stack.");
  }
  try {
    const claims = await getVerifier().verify(token);
    return {
      sub: claims.sub,
      email: claims.email ?? null,
      name: claims.name ?? claims.email ?? null,
      // Cognito group memberships (e.g. the §10c "admin" flag-management
      // group). Absent claim => empty list.
      groups: claims["cognito:groups"] ?? [],
    };
  } catch {
    throw new AuthError("Invalid or expired sign-in token.");
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
    this.code = "BAD_ID_TOKEN";
  }
}

// Test hook: node:test has no ergonomic ESM module mocking, so tests inject
// a fake verifier here (same pattern rationale as push.mjs's failure-path
// testing note in handler.test.mjs).
export function _setVerifierForTests(fake) {
  verifier = fake;
}
