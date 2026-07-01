import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { parseClientMessage } from "@me/claude-repl-protocol";
import { createSessionManager } from "./sessionManager.mjs";
import { log, scrub } from "./log.mjs";

const PORT = Number(process.env.PORT) || 8787;
const manager = createSessionManager();

const app = Fastify({ logger: false });
await app.register(websocket);

app.get("/healthz", async () => ({ ok: true }));
app.get("/readyz", async () => ({ ok: true, sessions: manager.size() }));

app.get("/ws", { websocket: true }, (socket) => {
  const session = manager.attach(socket);

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = parseClientMessage(raw.toString());
    } catch (err) {
      log.warn({ err: scrub(err.message) }, "rejected client message");
      return;
    }
    try {
      await manager.handleMessage(session, msg);
    } catch (err) {
      log.error({ err: scrub(err.message), session: session.id }, "handler error");
    }
  });

  socket.on("close", () => manager.teardown(session));
  socket.on("error", () => manager.teardown(session));
});

const shutdown = async (signal) => {
  log.info({ signal }, "shutting down — draining sandboxes");
  await manager.shutdown();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await app.listen({ port: PORT, host: "0.0.0.0" });
log.info({ port: PORT }, "claude-repl-backend listening");
