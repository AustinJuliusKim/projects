/**
 * Auth adapter interface (portability discipline #3): the app only ever
 * calls these two methods, so swapping Supabase for self-rolled magic links
 * + SES is a new adapter, not an app change. Our own users.id remains the
 * primary key everywhere — the adapter's user id is stored as users.auth_uid.
 *
 * @typedef {object} AuthAdapter
 * @property {(email: string, redirectTo: string) => Promise<void>} issueMagicLink
 *   Sends a magic-link email; the link lands on `${redirectTo}?token_hash=…&type=magiclink`.
 * @property {(tokenHash: string, type: string) => Promise<{id: string, email: string}|null>} verifyToken
 *   Exchanges a token hash for the provider's {id, email}; null when invalid/expired.
 */

export {};
