import express from "express";
import cors from "cors";
import { env, llmConfigured, usesRouter, usesOG } from "./env.js";
import "./db.js"; // initialize schema
import { api } from "./routes/api.js";
import { auth } from "./routes/auth.js";
import { stream } from "./routes/stream.js";

const app = express();
// Credentialed CORS so the dashboard can send the session cookie cross-origin.
const origins = (process.env.REINS_CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: origins.length ? origins : true,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) =>
  res.json({ ok: true, llm: llmConfigured, model: env.llm.model, auth: env.authEnabled })
);

app.use("/api", auth);
app.use("/api", api);
app.use("/api", stream);

app.listen(env.port, () => {
  console.log(`\n  reins server -> http://localhost:${env.port}`);
  const backend = usesRouter
    ? `0G Compute (Private Computer router) (${env.llm.model})`
    : usesOG
      ? `0G Compute (broker SDK) (${env.llm.model})`
      : llmConfigured
        ? `${env.llm.baseURL} (${env.llm.model})`
        : "NOT CONFIGURED (degraded mode)";
  console.log(`  inference    -> ${backend}`);
  console.log(`  storage      -> ${env.og.storageEnabled ? "0G Storage (on)" : "local only"}`);
  console.log(`  auth         -> ${env.authEnabled ? "ON (multi-tenant)" : "off (open instance)"}\n`);
});
