/**
 * Supabase GoTrue implementation of the auth adapter — plain REST via
 * fetch, no Supabase SDK (portability discipline: Supabase is just a
 * managed magic-link mailer + Postgres here).
 */

/**
 * @param {{supabaseUrl: string, supabaseServiceRoleKey: string}} config
 * @returns {import("./adapter.js").AuthAdapter}
 */
export function createSupabaseAdapter({ supabaseUrl, supabaseServiceRoleKey }) {
  const headers = {
    "content-type": "application/json",
    apikey: supabaseServiceRoleKey,
    authorization: `Bearer ${supabaseServiceRoleKey}`,
  };

  return {
    async issueMagicLink(email, redirectTo) {
      const res = await fetch(
        `${supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ email, create_user: true }),
        },
      );
      if (!res.ok) {
        throw new Error(`supabase otp failed: ${res.status} ${await res.text()}`);
      }
    },

    async verifyToken(tokenHash, type) {
      const res = await fetch(`${supabaseUrl}/auth/v1/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: type || "magiclink", token_hash: tokenHash }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const user = data.user ?? data;
      if (!user?.id || !user?.email) return null;
      return { id: user.id, email: user.email };
    },
  };
}
