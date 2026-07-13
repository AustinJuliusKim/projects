/**
 * Fastify app factory. Authorization is enforced HERE — RLS in Postgres is
 * defense-in-depth only. All input crosses a Zod schema; the user name is
 * re-validated with the protocol's sanitizeUserName (the SAME function the
 * client uses) so the charset allowlist can't be bypassed by calling the
 * API directly.
 */

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { z } from "zod";
import { sanitizeUserName } from "@guided-repl/protocol";
import { SESSION_COOKIE, createSessionToken, hashToken, cookieOptions, sessionExpiry } from "./sessions.js";

export const EVENT_KINDS = new Set([
  "lesson_started",
  "lesson_completed",
  "branch_chosen",
  "capture_submitted",
  "account_created",
  "pack_purchased",
]);

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const anonIdSchema = z.string().uuid();

const magicLinkBody = z.object({
  email: emailSchema,
  anonId: anonIdSchema.optional(),
});

const verifyBody = z.object({
  tokenHash: z.string().min(1),
  type: z.string().min(1).default("magiclink"),
  anonId: anonIdSchema.optional(),
});

const leadBody = z.object({
  anonId: anonIdSchema,
  name: z.string().optional(),
  email: emailSchema.optional(),
  consent: z.boolean().default(false),
  source: z.string().min(1).max(64),
});

const progressBody = z.object({
  status: z.enum(["started", "completed"]),
  assertions: z.record(z.string(), z.unknown()).default({}),
  anonId: anonIdSchema.optional(),
});

const eventsBody = z.object({
  events: z
    .array(z.object({ kind: z.string().min(1), payload: z.record(z.string(), z.unknown()).default({}) }))
    .min(1)
    .max(20),
  anonId: anonIdSchema.optional(),
});

const accountPatchBody = z.object({
  name: z.string().optional(),
  marketingConsent: z.boolean().optional(),
});

/** @param {object} user @returns {object} the public profile shape */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    marketingConsent: user.marketing_consent ?? false,
  };
}

/**
 * @param {{repo: object, authAdapter: import("./auth/adapter.js").AuthAdapter, config: import("./config.js").ApiConfig}} deps
 * @returns {import("fastify").FastifyInstance}
 */
export function buildApp({ repo, authAdapter, config }) {
  const app = Fastify({ logger: false });

  app.register(cookie);
  app.register(cors, {
    origin: config.publicOrigin ? [config.publicOrigin] : false,
    credentials: true,
  });

  /** Parses a body against `schema`, replying 400 on failure (null return). */
  function parseBody(schema, request, reply) {
    const result = schema.safeParse(request.body ?? {});
    if (!result.success) {
      reply.code(400).send({ error: result.error.issues[0]?.message ?? "invalid body" });
      return null;
    }
    return result.data;
  }

  /** Resolves the signed-in user from the session cookie, or null. */
  async function sessionUser(request) {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const session = await repo.findSession(hashToken(token));
    if (!session) return null;
    return repo.getUser(session.user_id ?? session.userId);
  }

  /** Session user or a 401 reply (null return). */
  async function requireUser(request, reply) {
    const user = await sessionUser(request);
    if (!user) {
      reply.code(401).send({ error: "sign in required" });
      return null;
    }
    return user;
  }

  /**
   * Owner resolution for progress/events: the session wins; anonymous
   * callers must present their anonId.
   */
  async function resolveOwner(request, anonId) {
    const user = await sessionUser(request);
    if (user) return { ownerType: "user", ownerId: user.id };
    if (anonId) return { ownerType: "anon", ownerId: anonId };
    return null;
  }

  app.get("/api/health", async () => ({ ok: true }));

  // --- auth ---------------------------------------------------------------

  app.post("/api/auth/magic-link", async (request, reply) => {
    const body = parseBody(magicLinkBody, request, reply);
    if (!body) return;
    if (body.anonId) {
      await repo.upsertLead({
        anonId: body.anonId,
        email: body.email,
        consent: false,
        source: "magic-link-request",
      });
    }
    await authAdapter.issueMagicLink(body.email, `${config.publicOrigin}/auth/callback`);
    return { ok: true };
  });

  app.post("/api/auth/verify", async (request, reply) => {
    const body = parseBody(verifyBody, request, reply);
    if (!body) return;
    const identity = await authAdapter.verifyToken(body.tokenHash, body.type);
    if (!identity) {
      return reply.code(401).send({ error: "invalid or expired link" });
    }

    // One transaction: user upsert + session + anon merge + account event.
    const token = createSessionToken();
    const { user } = await repo.withTransaction(async (tx) => {
      let user = await tx.findUserByAuthUid(identity.id);
      let created = false;
      if (!user) {
        ({ user, created } = await tx.createUser({ authUid: identity.id, email: identity.email }));
      }
      await tx.createSession({
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: sessionExpiry(config.sessionTtlDays),
      });
      if (body.anonId) {
        await tx.mergeAnon(body.anonId, user.id);
      }
      if (created) {
        await tx.insertEvents([
          { ownerType: "user", ownerId: user.id, kind: "account_created", payload: {} },
        ]);
      }
      return { user };
    });

    reply.setCookie(SESSION_COOKIE, token, cookieOptions(config.sessionTtlDays));
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await repo.deleteSession(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return { user: publicUser(user) };
  });

  // --- leads ---------------------------------------------------------------

  app.post("/api/leads", async (request, reply) => {
    const body = parseBody(leadBody, request, reply);
    if (!body) return;
    let name = null;
    if (body.name !== undefined && body.name !== "") {
      // Same protocol function the client runs — the allowlist is enforced
      // server-side too, never trusted from the browser.
      name = sanitizeUserName(body.name);
      if (!name) {
        return reply.code(400).send({ error: "invalid name" });
      }
    }
    if (!name && !body.email) {
      return reply.code(400).send({ error: "name or email required" });
    }
    const lead = await repo.upsertLead({
      anonId: body.anonId,
      name,
      email: body.email ?? null,
      consent: body.consent,
      source: body.source,
    });
    return { ok: true, leadId: lead.id };
  });

  // --- progress ------------------------------------------------------------

  app.get("/api/progress", async (request, reply) => {
    const anonId = anonIdSchema.safeParse(request.query?.anonId);
    const owner = await resolveOwner(request, anonId.success ? anonId.data : undefined);
    if (!owner) {
      return reply.code(400).send({ error: "session or anonId required" });
    }
    return { progress: await repo.listProgress(owner) };
  });

  app.put("/api/progress/:lessonId", async (request, reply) => {
    const body = parseBody(progressBody, request, reply);
    if (!body) return;
    const owner = await resolveOwner(request, body.anonId);
    if (!owner) {
      return reply.code(400).send({ error: "session or anonId required" });
    }
    const row = await repo.upsertProgress({
      ...owner,
      lessonId: request.params.lessonId,
      status: body.status,
      assertions: body.assertions,
    });
    return { ok: true, updatedAt: row.updated_at };
  });

  // --- events ---------------------------------------------------------------

  app.post("/api/events", async (request, reply) => {
    const body = parseBody(eventsBody, request, reply);
    if (!body) return;
    for (const event of body.events) {
      if (!EVENT_KINDS.has(event.kind)) {
        return reply.code(400).send({ error: `unknown event kind "${event.kind}"` });
      }
    }
    const owner = await resolveOwner(request, body.anonId);
    if (!owner) {
      return reply.code(400).send({ error: "session or anonId required" });
    }
    await repo.insertEvents(
      body.events.map((e) => ({ ...owner, kind: e.kind, payload: e.payload })),
    );
    return { ok: true };
  });

  // --- account ---------------------------------------------------------------

  app.get("/api/account", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const [progress, balanceCents] = await Promise.all([
      repo.listProgress({ ownerType: "user", ownerId: user.id }),
      repo.walletBalance(user.id),
    ]);
    return { user: publicUser(user), progress, balanceCents };
  });

  app.patch("/api/account", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = parseBody(accountPatchBody, request, reply);
    if (!body) return;
    let name;
    if (body.name !== undefined) {
      name = sanitizeUserName(body.name);
      if (!name) {
        return reply.code(400).send({ error: "invalid name" });
      }
    }
    const updated = await repo.updateUser(user.id, {
      name,
      marketingConsent: body.marketingConsent,
    });
    return { user: publicUser(updated) };
  });

  app.get("/api/account/export", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const dump = await repo.exportAccount(user.id);
    reply.header("content-disposition", 'attachment; filename="guided-repl-account.json"');
    return dump;
  });

  app.delete("/api/account", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    await repo.withTransaction((tx) => tx.deleteAccountData(user.id));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  return app;
}
