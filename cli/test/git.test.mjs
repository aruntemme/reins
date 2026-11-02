import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real git, real repos in temp dirs. State (the snapshot cache) goes to a temp dir.
process.env.REINS_STATE_DIR = mkdtempSync(join(tmpdir(), "reins-gitstate-"));
const { gitSnapshot, repoPath, parsePorcelain } = await import("../lib/git.mjs");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "reins-git-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "a@x.test");
  g("config", "user.name", "A");
  writeFileSync(join(dir, "a.ts"), "1\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

/** Age the cached snapshot so the next call recomputes (as 15s later would). */
function expireCache() {
  const dir = process.env.REINS_STATE_DIR;
  for (const f of readdirSync(dir).filter((n) => n.startsWith("git-"))) {
    const p = join(dir, f);
    const c = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...c, at: 0 }));
  }
}

test("snapshot: branch, short head, default branch, dirty files (capped list, true count)", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "a.ts"), "2\n");
  writeFileSync(join(dir, "new.ts"), "x\n");
  const s = gitSnapshot(dir);
  assert.equal(s.branch, "main");
  assert.equal(s.defaultBranch, "main");
  assert.match(s.head, /^[0-9a-f]{12}$/);
  assert.equal(s.dirty, 2);
  assert.deepEqual(s.dirtyFiles.sort(), ["a.ts", "new.ts"]);
  assert.equal(repoPath(join(dir, "sub", "x.ts"), dir), "sub/x.ts");
  assert.equal(repoPath("/somewhere/else.ts", dir), null, "outside the repo is not shared");
  assert.equal(gitSnapshot(mkdtempSync(join(tmpdir(), "reins-nogit-"))), null);
});

test("porcelain parsing handles renames", () => {
  assert.deepEqual(parsePorcelain("R  new name.ts\0old.ts\0 M src/a.ts\0?? b.ts\0"), ["new name.ts", "src/a.ts", "b.ts"]);
});

test("merge detection: leaving a work branch for a default branch that contains its last commit", () => {
  const { dir, g } = repo();
  g("checkout", "-q", "-b", "feat/login");
  writeFileSync(join(dir, "login.ts"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "login");
  const onFeat = gitSnapshot(dir);
  assert.equal(onFeat.branch, "feat/login");
  assert.equal(onFeat.merged, undefined);
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", "merge feat/login", "feat/login");
  expireCache();
  const after = gitSnapshot(dir);
  assert.deepEqual(after.merged, { branch: "feat/login", head: onFeat.head });
  assert.equal(gitSnapshot(dir).merged, undefined, "reported once, never from cache");
  expireCache();
  assert.equal(gitSnapshot(dir).merged, undefined, "and not again on the next refresh");

  // Switching to main WITHOUT merging is not a merge.
  g("checkout", "-q", "-b", "feat/wip");
  writeFileSync(join(dir, "wip.ts"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "wip");
  expireCache();
  gitSnapshot(dir);
  g("checkout", "-q", "main");
  expireCache();
  assert.equal(gitSnapshot(dir).merged, undefined);
});
