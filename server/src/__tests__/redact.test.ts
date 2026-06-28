import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../redact.js";

test("masks an openadapter-style sk-cv key but keeps the scheme + surrounding text", () => {
  const input =
    "Use 'api.openadapter.in/v1' as base URL and 'sk-cv-7eb3688b7fdc4d5ea894fded00897332' as secret.";
  const out = redactSecrets(input);
  assert.ok(!out.includes("7eb3688b7fdc4d5ea894fded00897332"), "secret body must be gone");
  assert.ok(out.includes("sk-cv-‹redacted›"), "scheme prefix is kept");
  assert.ok(out.includes("api.openadapter.in/v1"), "the base URL is not a secret, keep it");
});

test("masks common provider tokens", () => {
  for (const t of [
    "sk-proj-ABCDEFGHIJKLMNOPQRST1234",
    "rk_admin_2e924abcdef0123456789abc",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-ABCDEFGHIJKL",
  ]) {
    const out = redactSecrets(`token ${t} here`);
    assert.ok(!out.includes(t.split(/[-_]/).pop()!.slice(-8)), `masked: ${t}`);
    assert.ok(out.includes("‹redacted›"), `produced a mask for ${t}`);
  }
});

test("masks a PEM private key block", () => {
  const pem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA==\n-----END OPENSSH PRIVATE KEY-----";
  const out = redactSecrets(`here is the key\n${pem}\nthanks`);
  assert.equal(out, "here is the key\n‹redacted private key›\nthanks");
});

test("masks a JWT", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const out = redactSecrets(`auth ${jwt}`);
  assert.ok(!out.includes(jwt));
  assert.ok(out.includes("‹redacted›"));
});

test("masks key=secret style assignments, keeping the field name", () => {
  const out = redactSecrets('export API_KEY="abc123def456ghi789" && go');
  assert.ok(!out.includes("abc123def456ghi789"));
  assert.ok(/API_KEY="‹redacted›"/.test(out) || /API.?KEY.*‹redacted›/.test(out));
});

test("leaves ordinary content and hex hashes alone", () => {
  // Hex hashes / git SHAs must remain readable.
  const keep = [
    "rolled up the digest job",
    "root hash 0x3f9a1c2bd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081920a3b4c5",
    "commit a034266 merged to main",
    "the password is wrong again", // 'wrong again' is not a secret-shaped value
  ];
  for (const s of keep) assert.equal(redactSecrets(s), s, `unchanged: ${s}`);
});

test("empty/undefined input is returned as-is", () => {
  assert.equal(redactSecrets(""), "");
  // @ts-expect-error exercising the guard
  assert.equal(redactSecrets(undefined), undefined);
});
