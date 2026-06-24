# Reins server — Express ingest/SSE/REST + distillation pipeline + MCP.
FROM node:22-bookworm-slim

# better-sqlite3 uses prebuilt binaries, but keep toolchain available as a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# SQLite lives on a mounted volume so data survives container restarts/redeploys.
ENV NODE_ENV=production
ENV REINS_DB=/data/reins.db
ENV PORT=4319
VOLUME ["/data"]
EXPOSE 4319

CMD ["npx", "tsx", "src/index.ts"]
