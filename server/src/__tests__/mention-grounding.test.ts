import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.REINS_DB = join(tmpdir(), `reins-mention-${randomUUID()}.db`);
const db = await import("../db.js");

// Mirror the distill.ts mention guard exactly: resolve the name, drop self,
// then require the teammate to be actually named in the event text.
function wouldHandOff(project: string, fromMember: string, to: string, eventText: string): boolean {
  const toId = db.resolveMember(project, to);
  if (!toId || toId === fromMember) return false;
  return db.memberNamedIn(project, toId, eventText);
}

test("memberNamedIn grounds @mentions to who is actually named in the event", () => {
  db.ensureProject("mg", "MentionGround", "w1");
  db.ensureMember("mg", "arun", "Arun");
  db.ensureMember("mg", "sridevi", "Sridevi");
  db.ensureMember("mg", "praveen", "Praveen Kumar");

  // Positive: the teammate is explicitly named.
  assert.equal(db.memberNamedIn("mg", "praveen", "heads up Praveen, the API is slow"), true);
  assert.equal(db.memberNamedIn("mg", "praveen", "blocked on the migration Praveen Kumar owns"), true, "full display name");
  assert.equal(db.memberNamedIn("mg", "sridevi", "@sridevi can you review this?"), true, "@handle form");
  assert.equal(db.memberNamedIn("mg", "arun", "discuss design changes with Arun"), true, "first name, any case");

  // Negative: the real-world false handoffs — self-directed prompts with NO teammate named.
  assert.equal(db.memberNamedIn("mg", "sridevi", "Review v1 codebase and estimate migration effort"), false);
  assert.equal(db.memberNamedIn("mg", "sridevi", "Note it down in todo for me"), false);
  assert.equal(db.memberNamedIn("mg", "sridevi", "Check existing implementation and propose enhancements"), false);
  assert.equal(db.memberNamedIn("mg", "sridevi", "Phase 3 complete"), false);

  // Word-boundary: a substring is not a match.
  assert.equal(db.memberNamedIn("mg", "arun", "the guardrails are around the runtime"), false, "'arun' inside 'around' must not match");
});

test("the full mention guard drops hallucinated targets but keeps real ones", () => {
  db.ensureProject("mg2", "MentionGround2", "w1");
  db.ensureMember("mg2", "arun", "Arun");
  db.ensureMember("mg2", "sridevi", "Sridevi");

  // arun's own prompt, model wrongly emits a mention to the only other teammate.
  assert.equal(
    wouldHandOff("mg2", "arun", "Sridevi", "Review PR #63 for blockers before merging"),
    false,
    "self-directed task with no teammate named -> no handoff, even if the model guessed a roster name"
  );

  // arun genuinely loops in sridevi.
  assert.equal(
    wouldHandOff("mg2", "arun", "Sridevi", "@sridevi can you take the search endpoint?"),
    true,
    "explicitly named teammate -> real handoff survives"
  );

  // self-mention is always dropped regardless of grounding.
  assert.equal(wouldHandOff("mg2", "arun", "Arun", "note for Arun: rebase later"), false, "no self-handoffs");

  // name not on the roster -> dropped.
  assert.equal(wouldHandOff("mg2", "arun", "Bob", "ping Bob about the deploy"), false, "off-roster name -> no handoff");
});
