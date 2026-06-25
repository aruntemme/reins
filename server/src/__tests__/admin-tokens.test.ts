import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

// Fresh isolated DB + auth ON. Set BEFORE importing anything that opens the DB.
const DB = join(tmpdir(), `reins-admin-${randomUUID()}.db`);
process.env.REINS_DB = DB;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test";

// Seed a workspace and two tokens in THIS process (shares the same DB file).
const auth = await import("../auth.js");
const ws = auth.createWorkspace("Test Team");
const adminToken = auth.mintToken(ws.id, "admin", "bootstrap");
const accessToken = auth.mintToken(ws.id, "access", "dashboard");

const PORT = 4336;
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) return res();
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return rej(new Error("server did not start"));
      setTimeout(tick, 150);
    };
    tick();
  });
}

test("admin can list workspace tokens and revoke one over HTTP", async () => {
  // Spawn the REAL server with the same DB + auth env so it sees the seeded tokens.
  const entry = resolve(import.meta.dirname, "../index.ts");
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", entry],
    {
      env: {
        ...process.env,
        REINS_DB: DB,
        REINS_AUTH: "on",
        REINS_SESSION_SECRET: "test",
        PORT: String(PORT),
      },
      stdio: "ignore",
    }
  );

  try {
    await waitForServer();

    // List tokens with the admin bearer -> the 2 seeded tokens.
    const listRes = await fetch(`${BASE}/api/admin/tokens`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(listRes.status, 200);
    const { tokens } = (await listRes.json()) as {
      tokens: { id: string; kind: string; revoked: number }[];
    };
    assert.equal(tokens.length, 2);
    const kinds = tokens.map((t) => t.kind).sort();
    assert.deepEqual(kinds, ["access", "admin"]);

    // Non-admin (access) bearer is rejected by requireAdmin.
    const denied = await fetch(`${BASE}/api/admin/tokens`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(denied.status, 401);

    // Revoke the access token by id.
    const accessRow = tokens.find((t) => t.kind === "access");
    assert.ok(accessRow, "access token row present");
    const revRes = await fetch(`${BASE}/api/admin/tokens/${accessRow!.id}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(revRes.status, 200);
    assert.deepEqual(await revRes.json(), { ok: true });
  } finally {
    child.kill("SIGKILL");
  }

  // The server process owns the DB while running; verify revocation effect in
  // THIS process after the child is killed (same file, fresh read).
  assert.equal(auth.verifyToken(accessToken), null, "revoked token no longer verifies");
  assert.ok(auth.verifyToken(adminToken), "admin token still valid");
});
