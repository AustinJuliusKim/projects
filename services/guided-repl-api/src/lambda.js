/**
 * AWS Lambda entrypoint: the same buildApp() behind @fastify/aws-lambda,
 * fronted by API Gateway (HttpApi) and CloudFront's /api/* behavior.
 */

import awsLambdaFastify from "@fastify/aws-lambda";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createRepo } from "./repo.js";
import { createSupabaseAdapter } from "./auth/supabaseAdapter.js";

const config = loadConfig();
const repo = createRepo(createPool(config.databaseUrl));
const app = buildApp({ repo, authAdapter: createSupabaseAdapter(config), config });

export const handler = awsLambdaFastify(app);
