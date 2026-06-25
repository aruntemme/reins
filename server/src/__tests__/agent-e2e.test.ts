import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Fresh temp DB shared between this test (to seed/inspect) and the child server.
const DB_PATH = join(tmpdir(), `reins-agent-e2e-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;

// Import db.ts AFTER REINS_DB is set so it opens on the same file the child uses.
const db = await import("../db.js");
const agent = await import("../../../agent/reins-agent.mjs");

/** Ask the OS for a free port so parallel test runs never collide. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy in time");
}

test("autonomous agent claims then resolves open pending and records a source:auto note", async () => {
  // Seed a project with one OPEN pending item using the same DB the server opens.
  const project = "e2e-proj";
  db.ensureProject(project, "E2E", "default");
  const pendingId = db.upsertPending(project, "alice", "ship the docs page");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const indexPath = resolve(import.meta.dirname, "..", "index.ts");

  // Real server as a child process — no stubs. Auth off, same temp DB.
  const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
    env: {
      ...process.env,
      PORT: String(port),
      REINS_DB: DB_PATH,
      REINS_AUTH: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);

    // 1) Dry run: must change nothing.
    const dry = await agent.runOnce({ url, project, by: "auto-agent", policy: "all", dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.claimed.length, 0);
    assert.equal(dry.matched.length, 1, "dry run should still see the open item");
    let row = db.db.prepare("SELECT status FROM pending WHERE id = ?").get(pendingId) as { status: string };
    assert.equal(row.status, "open", "dry run must not mutate the pending row");

    const eventsBefore = db.db
      .prepare("SELECT COUNT(*) c FROM events WHERE source = 'auto'")
      .get() as { c: number };
    assert.equal(eventsBefore.c, 0);

    // 2) Real run: claim + resolve, and post the source:auto note.
    const real = await agent.runOnce({ url, project, by: "auto-agent", policy: "all", dryRun: false });
    assert.deepEqual(real.claimed, [pendingId]);
    assert.deepEqual(real.resolved, [pendingId]);
    assert.equal(real.noted, true);

    row = db.db.prepare("SELECT status FROM pending WHERE id = ?").get(pendingId) as { status: string };
    assert.equal(row.status, "done", "item should be resolved (done) after a real run");

    const autoEvent = db.db
      .prepare("SELECT member, source FROM events WHERE source = 'auto' ORDER BY created_at DESC LIMIT 1")
      .get() as { member: string; source: string } | undefined;
    assert.ok(autoEvent, "a source=auto event must be recorded");
    assert.equal(autoEvent!.source, "auto");
    assert.equal(autoEvent!.member, "auto-agent");

    // 3) Endpoint now returns no open items.
    const left = await agent.fetchOpenPending({ url, project });
    assert.equal(left.length, 0);
  } finally {
    child.kill("SIGKILL");
  }
});
