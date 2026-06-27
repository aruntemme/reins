import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Auth ON so we exercise the real ownership gates on trait editing.
const DB_PATH = join(tmpdir(), `reins-traits-routes-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-traits";

// Same DB file as the spawned server — used only to SEED traits (there is no
// create-trait HTTP route by design; traits are born in the pipeline).
const db = await import("../db.js");

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

function makeClient(base: string) {
  let cookie = "";
  return {
    async call(path: string, init: RequestInit = {}) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      };
      if (cookie) headers["cookie"] = cookie;
      const r = await fetch(`${base}${path}`, { ...init, headers });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      let body: any = null;
      try { body = await r.json(); } catch { /* none */ }
      return { status: r.status, body };
    },
  };
}

test("taste profile: readable by the team, editable only by its owner", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const indexPath = resolve(import.meta.dirname, "..", "index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
    env: { ...process.env, PORT: String(port), REINS_DB: DB_PATH, REINS_AUTH: "on", REINS_SESSION_SECRET: "test-secret-traits" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);

    // Owner of Acme with a project.
    const owner = makeClient(url);
    const ownerEmail = `owner-${randomUUID().slice(0, 8)}@acme.test`;
    const signup = await owner.call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "supersecret-1", workspaceName: "Acme" }),
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    await owner.call("/api/projects", { method: "POST", body: JSON.stringify({ id: "proj", name: "Proj" }) });

    const ownerMember = ownerEmail.toLowerCase(); // default effective member
    const other = "teammate-asha";

    // Seed member rows + traits directly (both are pipeline-born in production:
    // a member with traits always has activity, so a members row exists).
    db.ensureMember("proj", ownerMember);
    db.ensureMember("proj", other);
    db.applyTraitOps("proj", ownerMember, [{ op: "add", type: "tooling", statement: "prefers TypeScript", evidence: "ts everywhere" }]);
    db.applyTraitOps("proj", other, [{ op: "add", type: "quality", statement: "ships fast, polishes later", evidence: "rapid iterations" }]);

    // memberDetail exposes the profile (the abstraction) AND carries no raw text.
    const meDetail = await owner.call(`/api/projects/proj/members/${encodeURIComponent(ownerMember)}`);
    assert.equal(meDetail.status, 200, JSON.stringify(meDetail.body));
    assert.equal(meDetail.body.profile.length, 1);
    assert.equal(meDetail.body.profile[0].statement, "prefers TypeScript");
    assert.ok(!("events" in meDetail.body), "no raw events array leaks to the client");
    assert.ok(!("signals" in meDetail.body), "no raw-prompt surface at all on member detail");

    const myTraitId = meDetail.body.profile[0].id as string;

    // A teammate's profile is READABLE by the owner…
    const otherDetail = await owner.call(`/api/projects/proj/members/${encodeURIComponent(other)}`);
    assert.equal(otherDetail.status, 200);
    assert.equal(otherDetail.body.profile.length, 1);
    const otherTraitId = otherDetail.body.profile[0].id as string;

    // …but NOT editable: even the owner/admin can't touch a teammate's grain.
    const forbiddenPatch = await owner.call(`/api/traits/${otherTraitId}`, { method: "PATCH", body: JSON.stringify({ statement: "hijacked" }) });
    assert.equal(forbiddenPatch.status, 403, "a trait belongs to its member only");
    const forbiddenDelete = await owner.call(`/api/traits/${otherTraitId}`, { method: "DELETE" });
    assert.equal(forbiddenDelete.status, 403);

    // The owner CAN curate their own trait.
    const patch = await owner.call(`/api/traits/${myTraitId}`, { method: "PATCH", body: JSON.stringify({ statement: "strongly prefers TypeScript + Zod" }) });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const afterPatch = await owner.call(`/api/projects/proj/members/${encodeURIComponent(ownerMember)}`);
    assert.equal(afterPatch.body.profile[0].statement, "strongly prefers TypeScript + Zod");

    const del = await owner.call(`/api/traits/${myTraitId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const afterDelete = await owner.call(`/api/projects/proj/members/${encodeURIComponent(ownerMember)}`);
    assert.equal(afterDelete.body.profile.length, 0, "removed from the owner's profile");

    // Unknown trait → 404.
    const missing = await owner.call(`/api/traits/${randomUUID()}`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  } finally {
    child.kill("SIGKILL");
  }
});
