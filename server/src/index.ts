import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { env } from "./env.js";
import { db, pruneStale } from "./db.js"; // importing db initializes the schema
import { llmConfigured, activeModel } from "./llm/client.js";
import { api } from "./routes/api.js";
import { auth } from "./routes/auth.js";
import { stream } from "./routes/stream.js";
import { hook } from "./routes/hook.js";
import { projectsWithOpenCoordination } from "./db.js";
import { reconcileCollisions } from "./collisions.js";
import { recoverUndistilled, drainPipeline } from "./pipeline/index.js";

// Backstop: a stray rejected promise is logged, never allowed to kill the
// process (and the in-memory queue with it).
process.on("unhandledRejection", (reason: any) => {
  console.error("[unhandledRejection]", reason?.stack ?? reason);
});

const app = express();
app.set("trust proxy", env.trustProxy);
// Credentialed CORS so a dashboard on another origin (NEXT_PUBLIC_REINS_URL
// direct mode) can send the session cookie. Only the configured origins are
// allowed; with none configured there is no cross-origin access at all (the
// default same-origin /api rewrite doesn't need it).
const origins = (process.env.REINS_CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: origins.length ? origins : false,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  try {
    db.prepare("SELECT 1").get(); // prove the database is actually reachable
  } catch (e: any) {
    return res.status(503).json({ ok: false, error: `database unavailable: ${e?.message ?? e}` });
  }
  res.json({ ok: true, llm: llmConfigured(), model: activeModel().model, auth: env.authEnabled });
});

app.use("/api", auth);
app.use("/api", api);
app.use("/api", stream);
app.use("/api", hook);

// Errors from any route (incl. async ones via asyncHandler): log, answer JSON.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.error("[http]", err?.stack ?? err);
  res.status(status).json({ error: status >= 500 ? "internal error" : err?.message ?? "bad request" });
});

const server = app.listen(env.port, () => {
  console.log(`\n  reins server -> http://localhost:${env.port}`);
  const { model, label } = activeModel();
  const backend = llmConfigured() ? `${label} (${model})` : "NOT CONFIGURED (degraded mode)";
  console.log(`  inference    -> ${backend}`);
  console.log(`  auth         -> ${env.authEnabled ? "ON (multi-tenant)" : "off (open instance)"}\n`);
  const recovered = recoverUndistilled();
  if (recovered) console.log(`  [pipeline] re-queued ${recovered} undistilled event(s) from before the restart`);
});

// Hourly housekeeping: expired invites/resets, and raw event text past retention.
const prune = () => {
  try {
    const r = pruneStale(env.eventRetentionDays);
    if (r.invites || r.resets || r.events || r.touches) console.log("[prune]", JSON.stringify(r));
  } catch (e: any) {
    console.error("[prune]", e?.message ?? e);
  }
};
prune();
setInterval(prune, 60 * 60_000).unref();

// Overlaps also end by time (a touch ages out of its window, someone goes away)
// with no event to notice it, so sweep projects with open coordination handoffs.
const SWEEP_MS = Math.max(5_000, Number(process.env.REINS_COLLISION_SWEEP_MS ?? 120_000) || 120_000);
setInterval(() => {
  for (const p of projectsWithOpenCoordination()) {
    try { reconcileCollisions(p); } catch (e: any) { console.error("[sweep]", p, e?.message ?? e); }
  }
}, SWEEP_MS).unref();

// Graceful shutdown: stop accepting connections and new work, let running
// distills finish (bounded), then exit. Queued events are recovered on boot.
const GRACE_MS = Math.max(0, Number(process.env.REINS_SHUTDOWN_GRACE_MS ?? 8000) || 0);
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[shutdown] ${signal}: draining (up to ${GRACE_MS}ms)`);
  server.close(); // stop accepting new connections
  server.closeIdleConnections?.();
  const drained = await drainPipeline(GRACE_MS);
  if (!drained) console.log("[shutdown] grace period over; unfinished events will be re-queued on boot");
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
