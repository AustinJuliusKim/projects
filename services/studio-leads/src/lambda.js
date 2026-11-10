import { createHandler } from "./handler.js";
import { createStore } from "./store.js";
import { createWelcomeSender } from "./email.js";

export const handler = createHandler({
  saveLead: createStore(),
  sendWelcome: createWelcomeSender(),
  config: { sendWelcome: process.env.SEND_WELCOME === "true" },
  now: () => new Date(),
});
