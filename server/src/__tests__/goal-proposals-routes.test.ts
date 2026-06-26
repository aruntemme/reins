import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const DB_PATH = join(tmpdir(), `reins-goalprop-routes-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-gp";

// Same DB as the child server — used to file proposals directly (the real source
// is the LLM pipeline; here we exercise the accept/dismiss routes + permissions).
const db = await import("../db.js");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, () => { const a = srv.address(); const p = typeof a === "object" && a ? a.port : 0; srv.close(() => res(p)); });
  });
}
async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy");
}
function makeClient(base: string) {
  let cookie = "";
  return {
    async call(path: string, init: RequestInit = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
      if (cookie) headers["cookie"] = cookie;
      const r = await fetch(`${base}${path}`, { ...init, headers });
      const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]!;
      let body: any = null; try { body = await r.json(); } catch { /* none */ }
      return { status: r.status, body };
    },
  };
}

test("proposal routes: accept needs the goal's authority; dismiss; tenant-isolated", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const indexPath = resolve(import.meta.dirname, "..", "index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
    env: { ...process.env, PORT: String(port), REINS_DB: DB_PATH, REINS_AUTH: "on", REINS_SESSION_SECRET: "test-secret-gp" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);

    const owner = makeClient(url);
    const ownerEmail = `owner-${randomUUID().slice(0, 8)}@acme.test`;
    const signup = await owner.call("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "supersecret-1", workspaceName: "Acme" }) });
    const wsId = signup.body.workspace.id as string;
    await owner.call("/api/projects", { method: "POST", body: JSON.stringify({ id: "roadmap", name: "Roadmap" }) });

    // Owner sets a team goal + item.
    const team = await owner.call("/api/projects/roadmap/goals", { method: "POST", body: JSON.stringify({ scope: "team", title: "Ship", items: ["api"] }) });
    const teamId = team.body.id as string;

    // Member joins; the individual goal is created BY THEM (so they own it).
    const memberEmail = `dev-${randomUUID().slice(0, 8)}@acme.test`;
    const invite = await owner.call(`/api/workspaces/${wsId}/invites`, { method: "POST", body: JSON.stringify({ role: "member" }) });
    const member = makeClient(url);
    const ms = await member.call("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: memberEmail, password: "memberpw-123" }) });
    const memberHomeWs = ms.body.workspace.id as string;
    await member.call("/api/auth/join", { method: "POST", body: JSON.stringify({ code: invite.body.code }) });
    await member.call("/api/auth/switch", { method: "POST", body: JSON.stringify({ workspaceId: wsId }) });
    const mine = await member.call("/api/projects/roadmap/goals", { method: "POST", body: JSON.stringify({ scope: "individual", title: "Mine", items: ["draft"] }) });
    const mineId = mine.body.id as string;

    const list = (await owner.call("/api/projects/roadmap/goals")).body.goals;
    const teamItem = list.find((g: any) => g.id === teamId).items[0].id as string;
    const mineItem = list.find((g: any) => g.id === mineId).items[0].id as string;
    // The member owns "Mine" — its member is their effective identity (email).
    assert.equal(list.find((g: any) => g.id === mineId).member, memberEmail);

    // File proposals directly (stands in for the pipeline).
    const teamProp = db.createGoalProposal({ project: "roadmap", goalId: teamId, itemId: teamItem, kind: "check_item", reason: "shipped api", evidence: "e1", member: memberEmail })!;
    const mineProp = db.createGoalProposal({ project: "roadmap", goalId: mineId, itemId: mineItem, kind: "check_item", reason: "drafted", evidence: "e2", member: memberEmail })!;
    assert.ok(teamProp && mineProp);

    // Scoping: the owner (admin) sees only the TEAM proposal, not the member's.
    const ownerProps = (await owner.call("/api/projects/roadmap/goal-proposals")).body.proposals;
    assert.deepEqual(ownerProps.map((p: any) => p.id), [teamProp], "admin sees team proposals, not a teammate's individual one");
    // The member sees only THEIR individual proposal, not the team one.
    const memberProps = (await member.call("/api/projects/roadmap/goal-proposals")).body.proposals;
    assert.deepEqual(memberProps.map((p: any) => p.id), [mineProp], "member sees their own, not the team proposal");

    // Member CANNOT accept a TEAM-goal proposal (needs admin).
    assert.equal((await member.call(`/api/goal-proposals/${teamProp}/accept`, { method: "POST" })).status, 403);
    // Owner (admin) CANNOT accept the member's individual proposal.
    assert.equal((await owner.call(`/api/goal-proposals/${mineProp}/accept`, { method: "POST" })).status, 403, "admin can't act on a teammate's individual goal");

    // Each accepts what's theirs.
    assert.equal((await member.call(`/api/goal-proposals/${mineProp}/accept`, { method: "POST" })).status, 200);
    assert.equal((await owner.call(`/api/goal-proposals/${teamProp}/accept`, { method: "POST" })).status, 200);
    const after = (await owner.call("/api/projects/roadmap/goals")).body.goals;
    assert.equal(after.find((g: any) => g.id === mineId).items[0].done, true, "individual item ticked");
    assert.equal(after.find((g: any) => g.id === teamId).items[0].done, true, "team item ticked");

    // Dismiss: the member drops one of their own; it doesn't apply.
    const d = db.createGoalProposal({ project: "roadmap", goalId: mineId, kind: "add_item", text: "extra", reason: "spotted", member: memberEmail })!;
    assert.equal((await member.call(`/api/goal-proposals/${d}/dismiss`, { method: "POST" })).status, 200);
    const mineGoal = (await owner.call("/api/projects/roadmap/goals")).body.goals.find((g: any) => g.id === mineId);
    assert.ok(!mineGoal.items.some((i: any) => i.text === "extra"), "dismissed add_item was not applied");

    // Tenant isolation: from the member's own workspace, the proposals 404.
    await member.call("/api/auth/switch", { method: "POST", body: JSON.stringify({ workspaceId: memberHomeWs }) });
    assert.equal((await member.call("/api/projects/roadmap/goal-proposals")).status, 404);
  } finally {
    child.kill("SIGKILL");
  }
});
