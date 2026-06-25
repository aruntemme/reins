import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Fresh temp DB shared between this test (to call createReset directly) and the
// child server. REINS_DB must be set BEFORE importing ../db.js / ../auth.js so
// both processes open the same SQLite file. Auth is ON for these flows.
const DB_PATH = join(tmpdir(), `reins-account-routes-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-routes";

const authLib = await import("../auth.js");

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

/** Tiny session-aware client: threads the Set-Cookie back as Cookie. */
function makeClient(base: string) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      cookie = v;
    },
    async call(path: string, init: RequestInit = {}) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      };
      if (cookie) headers["cookie"] = cookie;
      const r = await fetch(`${base}${path}`, { ...init, headers });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!; // keep "reins_sess=..."
      let body: any = null;
      try {
        body = await r.json();
      } catch {
        /* no body */
      }
      return { status: r.status, body };
    },
  };
}

test("account routes: full signup/login/invite/join/switch/projects/reset flow", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const indexPath = resolve(import.meta.dirname, "..", "index.ts");

  const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
    env: {
      ...process.env,
      PORT: String(port),
      REINS_DB: DB_PATH,
      REINS_AUTH: "on",
      REINS_SESSION_SECRET: "test-secret-routes",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);

    const owner = makeClient(url);
    const ownerEmail = `owner-${randomUUID().slice(0, 8)}@acme.test`;

    // 1) Signup -> owner of a fresh workspace, tokens minted, session set.
    const signup = await owner.call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "supersecret-1", workspaceName: "Acme" }),
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    assert.equal(signup.body.ok, true);
    assert.equal(signup.body.user.email, ownerEmail.toLowerCase());
    assert.equal(signup.body.workspace.name, "Acme");
    assert.ok(signup.body.tokens.ingest && signup.body.tokens.access && signup.body.tokens.admin);
    const wsId = signup.body.workspace.id as string;

    // me shows owner + workspace + role
    const me = await owner.call("/api/auth/me");
    assert.equal(me.body.auth, true);
    assert.equal(me.body.user.email, ownerEmail.toLowerCase());
    assert.equal(me.body.role, "owner");
    assert.equal(me.body.admin, true);
    assert.equal(me.body.workspace.id, wsId);
    assert.equal(me.body.workspaces.length, 1);

    // 2) Duplicate signup -> 409 (use a separate client; rate limit is per-IP but
    //    well under the limit here).
    const dup = makeClient(url);
    const dupRes = await dup.call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "anotherpw-12" }),
    });
    assert.equal(dupRes.status, 409, JSON.stringify(dupRes.body));

    // 3) Wrong password -> 401; correct -> 200 (new client, fresh session).
    const loginC = makeClient(url);
    const badLogin = await loginC.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "wrongwrong-1" }),
    });
    assert.equal(badLogin.status, 401);
    const goodLogin = await loginC.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "supersecret-1" }),
    });
    assert.equal(goodLogin.status, 200, JSON.stringify(goodLogin.body));
    assert.equal(goodLogin.body.workspace.id, wsId);

    // 4) Owner creates an invite (member role) -> code + url.
    const invite = await owner.call(`/api/workspaces/${wsId}/invites`, {
      method: "POST",
      headers: { origin: "https://app.example.com" },
      body: JSON.stringify({ role: "member", label: "new dev" }),
    });
    assert.equal(invite.status, 200, JSON.stringify(invite.body));
    assert.match(invite.body.code, /^inv_/);
    assert.equal(invite.body.url, `https://app.example.com/join?code=${invite.body.code}`);

    // Public preview leaks only name/role/valid.
    const preview = await owner.call(`/api/invites/${invite.body.code}`);
    assert.equal(preview.body.workspace, "Acme");
    assert.equal(preview.body.role, "member");
    assert.equal(preview.body.valid, true);
    assert.deepEqual(Object.keys(preview.body).sort(), ["role", "valid", "workspace"]);

    // 5) A SECOND user signs up, then joins via the code -> becomes a member.
    const member = makeClient(url);
    const memberEmail = `dev-${randomUUID().slice(0, 8)}@acme.test`;
    const memberSignup = await member.call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: memberEmail, password: "memberpw-123" }),
    });
    assert.equal(memberSignup.status, 200);
    const memberHomeWs = memberSignup.body.workspace.id as string;

    const join = await member.call("/api/auth/join", {
      method: "POST",
      body: JSON.stringify({ code: invite.body.code }),
    });
    assert.equal(join.status, 200, JSON.stringify(join.body));
    assert.equal(join.body.workspace.id, wsId);
    assert.equal(join.body.role, "member");

    // 6) Member calling invites on Acme -> 403 (still a member there, but their
    //    ACTIVE session is their own owned workspace; cross-ws id mismatch -> 404,
    //    and against their own ws they are owner so test a real member's lack of
    //    admin: switch into Acme first, then they are a member -> 401 admin gate).
    await member.call("/api/auth/switch", { method: "POST", body: JSON.stringify({ workspaceId: wsId }) });
    const memberInvite = await member.call(`/api/workspaces/${wsId}/invites`, {
      method: "POST",
      body: JSON.stringify({ role: "member" }),
    });
    assert.equal(memberInvite.status, 403, "a plain member must not create invites");

    // Owner sees two members now.
    const members = await owner.call(`/api/workspaces/${wsId}/members`);
    assert.equal(members.status, 200);
    assert.equal(members.body.members.length, 2);

    // 7) Switch workspace changes the active ws (owner switches to nothing else;
    //    member switches back to their own home workspace).
    const memberSwitch = await member.call("/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ workspaceId: memberHomeWs }),
    });
    assert.equal(memberSwitch.status, 200);
    assert.equal(memberSwitch.body.workspace.id, memberHomeWs);
    const memberMe = await member.call("/api/auth/me");
    assert.equal(memberMe.body.workspace.id, memberHomeWs);
    assert.equal(memberMe.body.role, "owner"); // owner of their own ws

    // Switching to a workspace you don't belong to -> 403.
    const badSwitch = await loginC.call("/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ workspaceId: memberHomeWs }),
    });
    assert.equal(badSwitch.status, 403);

    // 8) Owner creates a project scoped to Acme; member's other workspace can't see it.
    const proj = await owner.call("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: "acme-roadmap", name: "Acme Roadmap" }),
    });
    assert.equal(proj.status, 200, JSON.stringify(proj.body));
    assert.equal(proj.body.project.id, "acme-roadmap");

    // Member is currently active in their OWN workspace -> 404 on Acme's project.
    const crossRead = await member.call("/api/projects/acme-roadmap");
    assert.equal(crossRead.status, 404, "project must not be visible across tenants");

    // Bad slug rejected.
    const badSlug = await owner.call("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: "Bad Slug!", name: "x" }),
    });
    assert.equal(badSlug.status, 400);

    // 9) Password reset: mint a code via the helper (same DB), reset, re-login.
    const ownerRow = authLib.getUserByEmail(ownerEmail)!;
    const { code: resetCode } = authLib.createReset(ownerRow.id);
    const reset = await owner.call("/api/auth/reset", {
      method: "POST",
      body: JSON.stringify({ code: resetCode, password: "brand-new-pw-9" }),
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const relogin = makeClient(url);
    const oldFails = await relogin.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "supersecret-1" }),
    });
    assert.equal(oldFails.status, 401, "old password no longer works");
    const newWorks = await relogin.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "brand-new-pw-9" }),
    });
    assert.equal(newWorks.status, 200, JSON.stringify(newWorks.body));

    // Short password rejected on reset and signup.
    const shortReset = await owner.call("/api/auth/reset", {
      method: "POST",
      body: JSON.stringify({ code: "res_whatever", password: "short" }),
    });
    assert.equal(shortReset.status, 400);
  } finally {
    child.kill("SIGKILL");
  }
});
