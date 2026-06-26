import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Auth ON so we exercise the real role gates (team goals require owner/admin).
const DB_PATH = join(tmpdir(), `reins-goals-routes-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-goals";

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

test("goals routes: team goals need admin, individual goals are open, tenant-isolated", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const indexPath = resolve(import.meta.dirname, "..", "index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
    env: { ...process.env, PORT: String(port), REINS_DB: DB_PATH, REINS_AUTH: "on", REINS_SESSION_SECRET: "test-secret-goals" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);

    // Owner of Acme + a project.
    const owner = makeClient(url);
    const ownerEmail = `owner-${randomUUID().slice(0, 8)}@acme.test`;
    const signup = await owner.call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "supersecret-1", workspaceName: "Acme" }),
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    const wsId = signup.body.workspace.id as string;
    await owner.call("/api/projects", { method: "POST", body: JSON.stringify({ id: "roadmap", name: "Roadmap" }) });

    // Empty to start.
    const empty = await owner.call("/api/projects/roadmap/goals");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.goals, []);

    // Owner creates a TEAM goal with a checklist.
    const team = await owner.call("/api/projects/roadmap/goals", {
      method: "POST",
      body: JSON.stringify({ scope: "team", title: "Ship v1", items: ["api", "ui"] }),
    });
    assert.equal(team.status, 200, JSON.stringify(team.body));
    const teamId = team.body.id as string;

    // A member joins Acme.
    const invite = await owner.call(`/api/workspaces/${wsId}/invites`, {
      method: "POST", body: JSON.stringify({ role: "member" }),
    });
    const member = makeClient(url);
    const memberEmail = `dev-${randomUUID().slice(0, 8)}@acme.test`;
    const ms = await member.call("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: memberEmail, password: "memberpw-123" }) });
    const memberHomeWs = ms.body.workspace.id as string;
    await member.call("/api/auth/join", { method: "POST", body: JSON.stringify({ code: invite.body.code }) });
    await member.call("/api/auth/switch", { method: "POST", body: JSON.stringify({ workspaceId: wsId }) });

    // Member CANNOT create a team goal (403) but CAN create their own individual goal.
    const memberTeam = await member.call("/api/projects/roadmap/goals", {
      method: "POST", body: JSON.stringify({ scope: "team", title: "sneaky" }),
    });
    assert.equal(memberTeam.status, 403, "a plain member must not add a team goal");

    const mine = await member.call("/api/projects/roadmap/goals", {
      method: "POST",
      body: JSON.stringify({ scope: "individual", member: memberEmail, title: "My slice", items: ["draft"], parentId: teamId }),
    });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const mineId = mine.body.id as string;

    // The member also can't edit the team goal (403 on PATCH).
    const editTeam = await member.call(`/api/goals/${teamId}`, { method: "PATCH", body: JSON.stringify({ blocked: true }) });
    assert.equal(editTeam.status, 403);

    // Read back: team goal first, with the parented child rolled up.
    const list = await owner.call("/api/projects/roadmap/goals");
    assert.equal(list.status, 200);
    const teamView = list.body.goals.find((g: any) => g.id === teamId);
    const mineView = list.body.goals.find((g: any) => g.id === mineId);
    assert.equal(list.body.goals[0].id, teamId, "team goal sorts first");
    assert.equal(teamView.progress.total, 2, "own items");
    assert.equal(teamView.rollup.total, 3, "own + child's item rolled up");
    assert.equal(mineView.member, memberEmail.toLowerCase ? memberEmail : memberEmail);

    // Member ticks an item on their own goal.
    const itemId = mineView.items[0].id as string;
    const check = await member.call(`/api/goal-items/${itemId}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    assert.equal(check.status, 200);
    const after = await owner.call("/api/projects/roadmap/goals");
    assert.equal(after.body.goals.find((g: any) => g.id === mineId).progress.done, 1);

    // Tenant isolation: member switches to their OWN workspace -> Acme's goals 404.
    await member.call("/api/auth/switch", { method: "POST", body: JSON.stringify({ workspaceId: memberHomeWs }) });
    const cross = await member.call("/api/projects/roadmap/goals");
    assert.equal(cross.status, 404, "goals must not be visible across tenants");
  } finally {
    child.kill("SIGKILL");
  }
});
