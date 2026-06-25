import { test } from "node:test";
import assert from "node:assert/strict";

// Pure unit test for the policy matcher — no server, no db.
const { selectItems } = await import("../../../agent/reins-agent.mjs");

const items = [
  { id: "1", text: "fix the login bug", status: "open" },
  { id: "2", text: "write release notes", status: "open" },
  { id: "3", text: "refactor BUG report parser", status: "open" },
  { id: "4", text: "already taken", status: "claimed" },
];

test("policy 'all' selects every OPEN item (claimed ones are skipped)", () => {
  const picked = selectItems(items, "all");
  assert.deepEqual(picked.map((i) => i.id), ["1", "2", "3"]);
});

test("missing policy behaves like 'all'", () => {
  assert.deepEqual(selectItems(items, undefined).map((i) => i.id), ["1", "2", "3"]);
});

test("regex policy matches item text case-insensitively", () => {
  const picked = selectItems(items, "bug");
  // matches item 1 ("bug") and item 3 ("BUG"), skips the claimed one even if it matched
  assert.deepEqual(picked.map((i) => i.id), ["1", "3"]);
});

test("regex policy that matches nothing returns empty", () => {
  assert.deepEqual(selectItems(items, "deploy"), []);
});

test("an invalid regex throws a clear error", () => {
  assert.throws(() => selectItems(items, "("), /invalid --policy regex/);
});
