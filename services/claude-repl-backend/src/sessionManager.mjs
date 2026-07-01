import { randomUUID } from "node:crypto";
import { ClientMsg, ServerMsg, Mode, serverMessage } from "@me/claude-repl-protocol";
import { createSandbox, killSandbox, listWorkspace, readFile } from "./sandbox.mjs";
import { createPermissionBridge } from "./permissionBridge.mjs";
import { runPrompt } from "./claudeRunner.mjs";
import { createUsage, addUsage, capExceeded, usagePayload } from "./usage.mjs";
import { log } from "./log.mjs";

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 300_000;
const SESSION_TOKEN_CAP = Number(process.env.SESSION_TOKEN_CAP) || Infinity;

// Owns the lifecycle of every live REPL session. One Session per WS connection.
export function createSessionManager() {
  const sessions = new Map(); // id -> Session

  function attach(ws) {
    const session = {
      id: randomUUID(),
      ws,
      sandbox: null,
      apiKey: null, // in-memory only; never persisted or logged
      mode: Mode.ACCEPT_EDITS,
      claudeSessionId: null, // for --resume continuity
      activeRun: null,
      permission: createPermissionBridge(),
      usage: createUsage(SESSION_TOKEN_CAP),
      idleTimer: null,
    };
    sessions.set(session.id, session);
    touch(session);
    log.info({ session: session.id }, "session attached");
    return session;
  }

  function send(session, type, payload) {
    if (session.ws.readyState === 1) session.ws.send(serverMessage(type, payload));
  }

  function touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      log.info({ session: session.id }, "idle timeout");
      send(session, ServerMsg.ERROR, { message: "session idle — sandbox closed", code: "idle_timeout" });
      teardown(session);
    }, IDLE_TIMEOUT_MS);
  }

  async function handleMessage(session, msg) {
    touch(session);
    switch (msg.type) {
      case ClientMsg.SET_KEY:
        session.apiKey = msg.key;
        // Start the sandbox now, in parallel with the user typing, to hide cold start.
        ensureSandbox(session).catch((err) =>
          send(session, ServerMsg.ERROR, { message: `sandbox boot failed: ${err.message}`, code: "sandbox_error" }),
        );
        break;

      case ClientMsg.SET_MODE:
        session.mode = msg.mode;
        break;

      case ClientMsg.PROMPT:
        await handlePrompt(session, msg.text);
        break;

      case ClientMsg.APPROVE:
        session.permission.approve(msg.id);
        break;

      case ClientMsg.DENY:
        session.permission.deny(msg.id, msg.reason);
        break;

      case ClientMsg.INTERRUPT:
        await interrupt(session);
        break;
    }
  }

  async function ensureSandbox(session) {
    if (session.sandbox) return session.sandbox;
    session.sandbox = await createSandbox();
    send(session, ServerMsg.SESSION_READY, {});
    return session.sandbox;
  }

  async function handlePrompt(session, text) {
    if (!session.apiKey) {
      send(session, ServerMsg.ERROR, { message: "no API key set", code: "no_key" });
      return;
    }
    if (session.activeRun) {
      send(session, ServerMsg.ERROR, { message: "a run is already in progress", code: "busy" });
      return;
    }
    if (capExceeded(session.usage)) {
      send(session, ServerMsg.ERROR, { message: "session token cap reached", code: "cap_exceeded" });
      return;
    }

    const sandbox = await ensureSandbox(session);

    // Plan / Accept-edits gate actions through the approval tool; Auto does not.
    const permissionToolName =
      session.mode === Mode.AUTO ? null : "mcp__approvals__approve";

    const onMessage = (m) => {
      if (m.type === ServerMsg.SESSION_READY && m.sessionId) {
        session.claudeSessionId = m.sessionId; // capture for --resume
        return;
      }
      if (m.type === ServerMsg.USAGE) {
        addUsage(session.usage, m);
        send(session, ServerMsg.USAGE, usagePayload(session.usage));
        return;
      }
      const { type, ...payload } = m;
      send(session, type, payload);
    };

    try {
      const run = await runPrompt(
        sandbox,
        {
          prompt: text,
          mode: session.mode,
          apiKey: session.apiKey,
          resumeId: session.claudeSessionId,
          permissionToolName,
        },
        onMessage,
      );
      session.activeRun = run;
      await run.done;
    } catch (err) {
      send(session, ServerMsg.ERROR, { message: err.message, code: "run_error" });
    } finally {
      session.activeRun = null;
      await reconcileWorkspace(session);
      send(session, ServerMsg.DONE, {});
    }
  }

  // After a run, list the real sandbox FS so files created by bash (not just
  // Write/Edit tool events) show up in the right pane.
  async function reconcileWorkspace(session) {
    if (!session.sandbox) return;
    try {
      const tree = await listWorkspace(session.sandbox);
      send(session, ServerMsg.FILE_TREE, { tree });
    } catch (err) {
      log.warn({ err }, "workspace reconcile failed");
    }
  }

  // Lazy file fetch when the user clicks a file in the tree.
  async function getFile(session, relPath) {
    if (!session.sandbox) return;
    try {
      const content = await readFile(session.sandbox, relPath);
      send(session, ServerMsg.FILE_CONTENT, { path: relPath, content });
    } catch (err) {
      send(session, ServerMsg.ERROR, { message: `read failed: ${err.message}`, code: "read_error" });
    }
  }

  async function interrupt(session) {
    session.permission.rejectAll("interrupted");
    if (session.activeRun) {
      await session.activeRun.handle.kill().catch(() => {});
      session.activeRun = null;
    }
  }

  async function teardown(session) {
    clearTimeout(session.idleTimer);
    session.permission.rejectAll("session ended");
    if (session.activeRun) await session.activeRun.handle.kill().catch(() => {});
    await killSandbox(session.sandbox);
    session.apiKey = null; // drop the key
    session.sandbox = null;
    sessions.delete(session.id);
    if (session.ws.readyState === 1) session.ws.close();
    log.info({ session: session.id }, "session torn down");
  }

  async function shutdown() {
    await Promise.all([...sessions.values()].map(teardown));
  }

  return { attach, handleMessage, getFile, teardown, shutdown, size: () => sessions.size };
}
