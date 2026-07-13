/**
 * In-memory repo stub implementing the exact interface app.js consumes —
 * unit tests exercise routes/authz/validation without Postgres. The
 * TEST_DATABASE_URL-gated integration suite covers the real SQL.
 */

import crypto from "node:crypto";

export function createMemRepo() {
  const state = {
    users: [],
    leads: [],
    progress: [],
    events: [],
    sessions: [],
    wallet: [],
  };

  const repo = {
    state,

    async findUserByAuthUid(authUid) {
      return state.users.find((u) => u.auth_uid === authUid) ?? null;
    },

    async findUserByEmail(email) {
      return state.users.find((u) => u.email === email.toLowerCase()) ?? null;
    },

    async getUser(id) {
      return state.users.find((u) => u.id === id) ?? null;
    },

    async createUser({ authUid, email }) {
      const existing = await repo.findUserByEmail(email);
      if (existing) {
        existing.auth_uid = authUid;
        return { user: existing, created: false };
      }
      const user = {
        id: crypto.randomUUID(),
        auth_uid: authUid,
        email: email.toLowerCase(),
        name: null,
        marketing_consent: false,
        stripe_customer_id: null,
        created_at: new Date(),
      };
      state.users.push(user);
      return { user, created: true };
    },

    async updateUser(id, { name, marketingConsent }) {
      const user = await repo.getUser(id);
      if (!user) return null;
      if (name !== undefined && name !== null) user.name = name;
      if (marketingConsent !== undefined && marketingConsent !== null) user.marketing_consent = marketingConsent;
      return user;
    },

    async upsertLead({ anonId, name, email, consent, source }) {
      const lead = {
        id: crypto.randomUUID(),
        anon_id: anonId,
        name: name ?? null,
        email: email ?? null,
        consent,
        source,
        claimed_by: null,
        created_at: new Date(),
      };
      state.leads.push(lead);
      return lead;
    },

    async upsertProgress({ ownerType, ownerId, lessonId, status, assertions }) {
      let row = state.progress.find(
        (p) => p.owner_type === ownerType && p.owner_id === ownerId && p.lesson_id === lessonId,
      );
      if (!row) {
        row = { id: crypto.randomUUID(), owner_type: ownerType, owner_id: ownerId, lesson_id: lessonId };
        state.progress.push(row);
      }
      row.status = status;
      row.assertions = assertions ?? {};
      row.updated_at = new Date();
      return row;
    },

    async listProgress({ ownerType, ownerId }) {
      return state.progress
        .filter((p) => p.owner_type === ownerType && p.owner_id === ownerId)
        .map((p) => ({ lesson_id: p.lesson_id, status: p.status, assertions: p.assertions, updated_at: p.updated_at }))
        .sort((a, b) => a.lesson_id.localeCompare(b.lesson_id));
    },

    async insertEvents(events) {
      for (const e of events) {
        state.events.push({
          id: state.events.length + 1,
          owner_type: e.ownerType,
          owner_id: e.ownerId ?? null,
          kind: e.kind,
          payload: e.payload ?? {},
          created_at: new Date(),
        });
      }
    },

    async mergeAnon(anonId, userId) {
      for (const anonRow of state.progress.filter((p) => p.owner_type === "anon" && p.owner_id === anonId)) {
        const userRow = state.progress.find(
          (p) => p.owner_type === "user" && p.owner_id === userId && p.lesson_id === anonRow.lesson_id,
        );
        if (userRow) {
          const loser = userRow.updated_at >= anonRow.updated_at ? anonRow : userRow;
          state.progress.splice(state.progress.indexOf(loser), 1);
        }
      }
      for (const p of state.progress) {
        if (p.owner_type === "anon" && p.owner_id === anonId) {
          p.owner_type = "user";
          p.owner_id = userId;
        }
      }
      for (const e of state.events) {
        if (e.owner_type === "anon" && e.owner_id === anonId) {
          e.owner_type = "user";
          e.owner_id = userId;
        }
      }
      for (const l of state.leads) {
        if (l.anon_id === anonId) l.claimed_by = userId;
      }
    },

    async walletBalance(userId) {
      return state.wallet.filter((w) => w.user_id === userId).reduce((sum, w) => sum + w.amount_cents, 0);
    },

    async createSession({ tokenHash, userId, expiresAt }) {
      state.sessions.push({ id: crypto.randomUUID(), token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
    },

    async findSession(tokenHash) {
      return state.sessions.find((s) => s.token_hash === tokenHash && s.expires_at > new Date()) ?? null;
    },

    async deleteSession(tokenHash) {
      state.sessions = state.sessions.filter((s) => s.token_hash !== tokenHash);
    },

    async exportAccount(userId) {
      return {
        user: await repo.getUser(userId),
        progress: await repo.listProgress({ ownerType: "user", ownerId: userId }),
        events: state.events.filter((e) => e.owner_type === "user" && e.owner_id === userId),
        leads: state.leads.filter((l) => l.claimed_by === userId),
        walletLedger: state.wallet.filter((w) => w.user_id === userId),
      };
    },

    async deleteAccountData(userId) {
      state.wallet = state.wallet.filter((w) => w.user_id !== userId);
      state.progress = state.progress.filter((p) => !(p.owner_type === "user" && p.owner_id === userId));
      for (const e of state.events) {
        if (e.owner_type === "user" && e.owner_id === userId) e.owner_id = null;
      }
      for (const l of state.leads) {
        if (l.claimed_by === userId) {
          l.name = null;
          l.email = null;
        }
      }
      state.sessions = state.sessions.filter((s) => s.user_id !== userId);
      state.users = state.users.filter((u) => u.id !== userId);
    },

    async withTransaction(fn) {
      return fn(repo);
    },
  };

  return repo;
}
