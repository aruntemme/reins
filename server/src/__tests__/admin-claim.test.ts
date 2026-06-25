import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
// The CLI child process below is given the SAME file so we can assert its effects
// through the real db/auth helpers (no mocks — a real CLI against real SQLite).
const DB = join(tmpdir(), `reins-adminclaim-${randomUUID()}.db`);
process.env.REINS_DB = DB;

const auth = await import("../auth.js");

const ADMIN_TS = resolve(import.meta.dirname, "..", "admin.ts");

/** Run the real admin CLI as a child against the shared temp DB. */
function runCli(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", ADMIN_TS, ...args],
    { env: { ...process.env, REINS_DB: DB, ...env }, encoding: "utf8" }
  );
}

test("claim-workspace attaches an existing user as owner", () => {
  const ws = auth.createWorkspace("My Team");
  const email = `existing-${randomUUID()}@example.com`;
  const user = auth.createUser(email, "initial-password");

  const out = runCli(["claim-workspace", ws.id, email]);

  const m = auth.getMembership(user.id, ws.id);
  assert.equal(m?.role, "owner", "existing user must become owner");
  // An existing account keeps its password — no reset link should be printed.
  assert.ok(!out.includes("/reset?code="), "must not mint a reset link for an existing account");
  assert.ok(out.includes(email), "summary should mention the email");
});

test("claim-workspace creates a new user with owner membership and a reset link", () => {
  const ws = auth.createWorkspace("Live Team");
  const email = `fresh-${randomUUID()}@example.com`;
  assert.equal(auth.getUserByEmail(email), undefined, "user must not exist yet");

  const out = runCli(["claim-workspace", ws.id, email]);

  const user = auth.getUserByEmail(email);
  assert.ok(user, "user must be created");
  const m = auth.getMembership(user!.id, ws.id);
  assert.equal(m?.role, "owner", "new user must be an owner");
  assert.match(out, /\/reset\?code=res_[0-9a-f]+/, "must print a one-time reset link");
});

test("claim-workspace honours an explicit role argument", () => {
  const ws = auth.createWorkspace("Role Team");
  const email = `role-${randomUUID()}@example.com`;

  runCli(["claim-workspace", ws.id, email, "admin"]);

  const user = auth.getUserByEmail(email);
  assert.equal(auth.getMembership(user!.id, ws.id)?.role, "admin");
});

test("claim-workspace fails for a missing workspace", () => {
  let failed = false;
  try {
    runCli(["claim-workspace", "no-such-ws", `x-${randomUUID()}@example.com`]);
  } catch (e: any) {
    failed = true;
    assert.match(String(e.stderr), /no workspace/);
  }
  assert.ok(failed, "must exit non-zero for an unknown workspace");
});

test("reset-link prints a one-time link for an existing user", () => {
  const email = `reset-${randomUUID()}@example.com`;
  auth.createUser(email, "pw");

  const out = runCli(["reset-link", email]);
  assert.match(out, /\/reset\?code=res_[0-9a-f]+/, "must print a reset link");
  assert.ok(out.includes("7 days"), "should note the expiry");
});

test("reset-link uses REINS_PUBLIC_URL to build an absolute link", () => {
  const email = `abs-${randomUUID()}@example.com`;
  auth.createUser(email, "pw");

  const out = runCli(["reset-link", email], { REINS_PUBLIC_URL: "https://reins.example.com/" });
  assert.match(out, /https:\/\/reins\.example\.com\/reset\?code=res_[0-9a-f]+/);
});

test("reset-link errors for an unknown email", () => {
  let failed = false;
  try {
    runCli(["reset-link", `ghost-${randomUUID()}@example.com`]);
  } catch (e: any) {
    failed = true;
    assert.match(String(e.stderr), /no account/);
  }
  assert.ok(failed, "must exit non-zero for an unknown email");
});
