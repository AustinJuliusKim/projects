/**
 * Standalone listener — container/local entrypoint (the Lambda deploy uses
 * src/lambda.js instead; both wrap the same buildApp()).
 *
 * Local dev: FAKE_AUTH=1 swaps in the deterministic fake adapter so magic
 * links work without a Supabase project (the "email" token hash is
 * `fake-<email>`).
 */

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createRepo } from "./repo.js";
import { createSupabaseAdapter } from "./auth/supabaseAdapter.js";
import { createFakeAdapter } from "./auth/fakeAdapter.js";

const config = loadConfig();
const repo = createRepo(createPool(config.databaseUrl));
const authAdapter = process.env.FAKE_AUTH === "1" ? createFakeAdapter() : createSupabaseAdapter(config);

const app = buildApp({ repo, authAdapter, config });

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
app.listen({ port, host: "0.0.0.0" }).then((address) => {
  console.log(`guided-repl-api listening on ${address}`);
});
