import express from "express";
import cors from "cors";
import { env } from "./env.js";
import "./db.js"; // initialize schema
import { llmConfigured, activeModel } from "./llm/client.js";
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
  res.json({ ok: true, llm: llmConfigured(), model: activeModel().model, auth: env.authEnabled })
);

app.use("/api", auth);
app.use("/api", api);
app.use("/api", stream);

app.listen(env.port, () => {
  console.log(`\n  reins server -> http://localhost:${env.port}`);
  const { model, label } = activeModel();
  const backend = llmConfigured() ? `${label} (${model})` : "NOT CONFIGURED (degraded mode)";
  console.log(`  inference    -> ${backend}`);
  console.log(`  auth         -> ${env.authEnabled ? "ON (multi-tenant)" : "off (open instance)"}\n`);
});
