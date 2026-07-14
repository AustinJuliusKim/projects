# E2B sandbox template for the seeder's E2B runner.
#
# Build & publish under the EXACT alias the runner resolves — see
# src/runner/e2bRunner.js (`E2B_TEMPLATE = "guided-repl-seeder"`). Any other
# name and Sandbox.create() can't find it.
#
#   npm i -g @e2b/cli
#   cd services/guided-repl-seeder
#   E2B_API_KEY=... e2b template create guided-repl-seeder   # Build System v2; auto-finds this file
#
# Runtime contract this image must satisfy:
#   - node 20+                       (this base image)
#   - `claude` CLI on PATH           (global install below)
#   - writable /home/user/workspace  (e2bRunner.js SANDBOX_WORKDIR)
#
# ANTHROPIC_API_KEY is passed in as a sandbox env var at run time
# (defaultSandboxFactory) — never bake a key into the image.

FROM node:20-slim

RUN npm install -g @anthropic-ai/claude-code

RUN mkdir -p /home/user/workspace && chmod -R 777 /home/user
WORKDIR /home/user/workspace
