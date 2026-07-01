import { randomUUID } from "node:crypto";

// Bridges Claude Code's permission prompts to the browser's approve/deny.
//
// In Plan / Accept-edits modes the runner passes --permission-prompt-tool so
// Claude asks before gated actions. When a prompt arrives, we emit a
// `permission_request` to the browser and park a promise here keyed by id; the
// browser's `approve`/`deny` resolves it. In Auto (bypassPermissions) this
// bridge is never engaged.
//
// One bridge instance per session.
export function createPermissionBridge() {
  const pending = new Map(); // id -> { resolve }

  return {
    // Called when Claude requests permission. `emit` sends the protocol message
    // to the browser. Resolves to { allow: boolean, reason?: string }.
    request(tool, input, emit) {
      const id = randomUUID();
      emit({ id, tool, input });
      return new Promise((resolve) => {
        pending.set(id, { resolve });
      });
    },

    approve(id) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      entry.resolve({ allow: true });
      return true;
    },

    deny(id, reason) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      entry.resolve({ allow: false, reason: reason || "denied by user" });
      return true;
    },

    // On teardown / interrupt, deny everything still waiting so no promise leaks.
    rejectAll(reason = "session ended") {
      for (const { resolve } of pending.values()) {
        resolve({ allow: false, reason });
      }
      pending.clear();
    },

    get size() {
      return pending.size;
    },
  };
}
