import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Isolate DB + a stable session secret BEFORE importing anything that reads env/db.
process.env.REINS_DB = join(tmpdir(), `reins-accounts-${randomUUID()}.db`);
process.env.REINS_SESSION_SECRET = "test-secret-accounts";

const a = await import("../auth.js");

test("password hashing: scrypt round-trips and rejects wrong/tampered input", () => {
  const stored = a.hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(a.verifyPassword("correct horse battery staple", stored), true);
  assert.equal(a.verifyPassword("wrong", stored), false);
  assert.equal(a.verifyPassword("correct horse battery staple", stored.slice(0, -2) + "00"), false);
  assert.equal(a.verifyPassword("x", "notscrypt"), false);
});

test("users: create, lookup, duplicate email rejected, password update", () => {
  const u = a.createUser("Alice@Example.com ", "pw-aaaaaaaa");
  assert.equal(u.email, "alice@example.com"); // normalized
  assert.equal(a.getUserById(u.id)?.email, "alice@example.com");
  const byEmail = a.getUserByEmail("alice@example.com");
  assert.ok(byEmail && a.verifyPassword("pw-aaaaaaaa", byEmail.password_hash));
  assert.throws(() => a.createUser("alice@example.com", "other"), /UNIQUE|constraint/i);

  a.setUserPassword(u.id, "pw-bbbbbbbb");
  const after = a.getUserByEmail("alice@example.com")!;
  assert.equal(a.verifyPassword("pw-bbbbbbbb", after.password_hash), true);
  assert.equal(a.verifyPassword("pw-aaaaaaaa", after.password_hash), false);
});

test("memberships: add, role, list, last-owner count, remove", () => {
  const ws = a.createWorkspace("Acme");
  const owner = a.createUser("owner@acme.com", "pw-owner-1");
  const member = a.createUser("dev@acme.com", "pw-dev-12");
  a.addMembership(owner.id, ws.id, "owner");
  a.addMembership(member.id, ws.id, "member");

  assert.equal(a.getMembership(owner.id, ws.id)?.role, "owner");
  assert.equal(a.countOwners(ws.id), 1);
  assert.equal(a.listMembers(ws.id).length, 2);
  assert.deepEqual(a.listMemberships(owner.id).map((m) => m.id), [ws.id]);

  assert.equal(a.setMemberRole(member.id, ws.id, "admin"), true);
  assert.equal(a.getMembership(member.id, ws.id)?.role, "admin");
  assert.equal(a.roleIsAdmin("admin"), true);
  assert.equal(a.roleIsAdmin("member"), false);

  assert.equal(a.removeMembership(member.id, ws.id), true);
  assert.equal(a.listMembers(ws.id).length, 1);
});

test("invites: single-use, adds membership, expired rejected", () => {
  const ws = a.createWorkspace("Beta");
  const inviter = a.createUser("boss@beta.com", "pw-boss-12");
  const joiner = a.createUser("new@beta.com", "pw-join-12");
  a.addMembership(inviter.id, ws.id, "owner");

  const { code } = a.createInvite(ws.id, "member", inviter.id, "new dev");
  const preview = a.getInvite(code);
  assert.equal(preview?.valid, true);
  assert.equal(preview?.workspaceId, ws.id);

  const res = a.acceptInvite(code, joiner.id);
  assert.equal(res?.workspaceId, ws.id);
  assert.equal(a.getMembership(joiner.id, ws.id)?.role, "member");
  // single-use: second accept fails and invite no longer valid
  assert.equal(a.acceptInvite(code, joiner.id), null);
  assert.equal(a.getInvite(code)?.valid, false);

  // expired invite cannot be accepted
  const expired = a.createInvite(ws.id, "member", inviter.id, undefined, -1);
  assert.equal(a.getInvite(expired.code)?.valid, false);
  assert.equal(a.acceptInvite(expired.code, joiner.id), null);
});

test("password reset: single-use link sets a new password", () => {
  const u = a.createUser("reset@x.com", "pw-old-1234");
  const { code } = a.createReset(u.id);
  assert.equal(a.useReset(code, "pw-new-1234"), true);
  const after = a.getUserByEmail("reset@x.com")!;
  assert.equal(a.verifyPassword("pw-new-1234", after.password_hash), true);
  // single-use
  assert.equal(a.useReset(code, "pw-third-123"), false);
  assert.equal(a.useReset("res_nonexistent", "x"), false);
});

test("user session: signs uid+ws, role comes from membership, invalid when removed/tampered", () => {
  const ws = a.createWorkspace("Gamma");
  const u = a.createUser("sess@g.com", "pw-sess-12");
  a.addMembership(u.id, ws.id, "admin");

  const cookie = a.signUserSession(u.id, ws.id, "admin");
  const info = a.verifySession(cookie);
  assert.equal(info?.userId, u.id);
  assert.equal(info?.workspaceId, ws.id);
  assert.equal(info?.kind, "user");
  assert.equal(info?.role, "admin");

  // role is authoritative from membership, not the cookie payload
  a.setMemberRole(u.id, ws.id, "member");
  assert.equal(a.verifySession(cookie)?.role, "member");

  // removing membership invalidates the session
  a.removeMembership(u.id, ws.id);
  assert.equal(a.verifySession(cookie), null);

  // tampered cookie rejected
  assert.equal(a.verifySession(cookie.slice(0, -3) + "zzz"), null);

  // token (non-user) session still works while its token is live
  const tok = a.verifyToken(a.mintToken(ws.id, "access"))!;
  const tokenCookie = a.signSession(ws.id, "access", tok.id);
  assert.equal(a.verifySession(tokenCookie)?.kind, "access");
});

test("token session dies with its token; a token can't be revoked from another workspace", () => {
  const ws = a.createWorkspace("Delta");
  const other = a.createWorkspace("Epsilon");
  const tok = a.verifyToken(a.mintToken(ws.id, "access"))!;
  const cookie = a.signSession(ws.id, "access", tok.id);
  assert.equal(a.verifySession(cookie)?.workspaceId, ws.id);

  assert.equal(a.revokeToken(tok.id, other.id), false, "other workspace can't revoke it");
  assert.ok(a.verifySession(cookie), "still valid after the cross-tenant attempt");

  assert.equal(a.revokeToken(tok.id, ws.id), true);
  assert.equal(a.verifySession(cookie), null, "revoking the token ends the session");
});

test("sessions expire server-side after the cookie max-age; legacy tid-less token sessions are refused", async () => {
  const { createHmac } = await import("node:crypto");
  const ws = a.createWorkspace("Zeta");
  const u = a.createUser("old@z.com", "pw-old-1234");
  a.addMembership(u.id, ws.id, "member");
  const sign = (data: object) => {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const sig = createHmac("sha256", process.env.REINS_SESSION_SECRET!).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  };
  const fresh = sign({ uid: u.id, ws: ws.id, k: "user", role: "member", ep: 0, iat: Date.now() });
  assert.ok(a.verifySession(fresh));
  const stale = sign({ uid: u.id, ws: ws.id, k: "user", role: "member", ep: 0, iat: Date.now() - a.SESSION_MAX_AGE_MS - 1000 });
  assert.equal(a.verifySession(stale), null, "older than 30 days is rejected");
  assert.equal(a.verifySession(sign({ ws: ws.id, k: "admin", iat: Date.now() })), null, "no token id → refused");
});

test("a password reset ends the account's existing sessions", () => {
  const ws = a.createWorkspace("Eta");
  const u = a.createUser("reset-sess@e.com", "pw-before-12");
  a.addMembership(u.id, ws.id, "member");
  const before = a.signUserSession(u.id, ws.id, "member");
  assert.ok(a.verifySession(before));
  const { code } = a.createReset(u.id);
  assert.equal(a.useReset(code, "pw-after-1234"), true);
  assert.equal(a.verifySession(before), null, "pre-reset session is dead");
  assert.ok(a.verifySession(a.signUserSession(u.id, ws.id, "member")), "a new login works");
});

test("accepting an invite never rewrites an existing membership role", () => {
  const ws = a.createWorkspace("Theta");
  const owner = a.createUser("sole-owner@t.com", "pw-owner-123");
  a.addMembership(owner.id, ws.id, "owner");
  const { code } = a.createInvite(ws.id, "member", owner.id);
  const r = a.acceptInvite(code, owner.id);
  assert.equal(r?.role, "owner");
  assert.equal(a.getMembership(owner.id, ws.id)?.role, "owner", "sole owner is not demoted");
  assert.equal(a.getInvite(code)?.valid, true, "invite stays unspent for its real recipient");
});
