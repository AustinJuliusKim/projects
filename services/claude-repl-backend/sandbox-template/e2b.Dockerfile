# E2B sandbox template for claude-repl: Node + Claude Code preinstalled so
# sessions start fast (no per-session npm install). Build with the E2B CLI:
#   e2b template build --name claude-repl
# then set E2B_TEMPLATE to the resulting id in the backend .env.
FROM node:20-slim

# Claude Code CLI, available as `claude` on PATH inside the sandbox.
RUN npm install -g @anthropic-ai/claude-code

# The directory Claude Code works in == the right-pane "workspace" view.
RUN mkdir -p /home/user/workspace
WORKDIR /home/user/workspace
