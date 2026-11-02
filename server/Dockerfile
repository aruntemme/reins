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

# Liveness for Docker/compose: /health also checks the database is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4319)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form with node itself as PID 1 (not `npx` → a shell → node), so
# SIGTERM from `docker stop` reaches the server and it shuts down gracefully
# (finishes in-flight distills; queued events are recovered on the next boot).
CMD ["node", "--import", "tsx", "src/index.ts"]
