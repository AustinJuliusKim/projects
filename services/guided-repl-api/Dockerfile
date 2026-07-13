# Container parity for the spec's Fastify-container assumption: the same
# buildApp() the Lambda deploy wraps, listening on :3001. Build from the
# REPO ROOT so the file: protocol dependency resolves:
#   docker build -f services/guided-repl-api/Dockerfile -t guided-repl-api .
FROM node:20-slim

WORKDIR /repo
COPY packages/guided-repl-protocol packages/guided-repl-protocol
COPY services/guided-repl-api services/guided-repl-api

WORKDIR /repo/services/guided-repl-api
RUN npm ci --omit=dev

ENV PORT=3001
EXPOSE 3001
CMD ["node", "src/server.js"]
