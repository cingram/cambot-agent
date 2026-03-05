# CamBot-Agent Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy cambot-llm package (local dependency for custom agent support)
COPY cambot-llm/ /cambot-llm/
RUN cd /cambot-llm && npm install --legacy-peer-deps && npm run build \
    && find /cambot-llm/src -name '*.ts' -not -path '*/node_modules/*' -exec md5sum {} + | sort | md5sum | cut -d' ' -f1 > /cambot-llm/.source-hash

# Copy package.json only (not lockfile — it has stale file: paths from local dev)
COPY cambot-agent-runner/package.json ./

# Fix cambot-llm path for container context (local dev uses ../../cambot-llm)
RUN sed -i 's|"cambot-llm": "file:../../cambot-llm"|"cambot-llm": "file:/cambot-llm"|' package.json

# Install dependencies (fresh resolve, no stale lockfile)
RUN npm install --legacy-peer-deps

# Copy source code and config (not package.json — already sed-fixed above)
COPY cambot-agent-runner/src/ ./src/
COPY cambot-agent-runner/tsconfig.json ./

# Build TypeScript and save source hash for entrypoint cache check
RUN npm run build \
    && find /app/src -name '*.ts' -not -path '*/node_modules/*' -exec md5sum {} + | sort | md5sum | cut -d' ' -f1 > /app/.source-hash

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (smart recompilation — skips tsc when source unchanged)
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
# /cambot-llm needs write access so the entrypoint can rebuild from hot-mounted source
RUN chown -R node:node /workspace /cambot-llm && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
