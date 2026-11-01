import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { redactSecrets } from "../lib/redact.mjs";
import { sendEvent } from "../lib/capture.mjs";

// ---- pure redaction ----

test("redactSecrets masks an sk-cv key, keeps the scheme + base URL", () => {
  const out = redactSecrets(
    "Use 'api.openadapter.in/v1' as base URL and 'sk-cv-7eb3688b7fdc4d5ea894fded00897332' as secret."
  );
  assert.ok(!out.includes("7eb3688b7fdc4d5ea894fded00897332"));
  assert.ok(out.includes("sk-cv-‹redacted›"));
  assert.ok(out.includes("api.openadapter.in/v1"));
});

test("redactSecrets leaves ordinary text and hex hashes untouched", () => {
  const s = "root hash 0x3f9a1c2bd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081920a3b4c5";
  assert.equal(redactSecrets(s), s);
});

// ---- end to end: secrets are masked BEFORE leaving the machine ----

async function captureServer() {
  let received = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0);
  await once(server, "listening");
  return { url: `http://localhost:${server.address().port}`, get: () => received, close: () => server.close() };
}

test("sendEvent redacts the secret in the body that hits the wire", async () => {
  const srv = await captureServer();
  try {
    const res = await sendEvent({
      url: srv.url,
      project: "p",
      member: "me",
      text: "set OPENAI_API_KEY to sk-cv-7eb3688b7fdc4d5ea894fded00897332 and run",
    });
    assert.equal(res.ok, true);
    const sent = srv.get();
    assert.ok(sent, "server received a body");
    assert.ok(!sent.text.includes("7eb3688b7fdc4d5ea894fded00897332"), "secret never left the machine");
    assert.ok(sent.text.includes("sk-cv-‹redacted›"));
  } finally {
    srv.close();
  }
});

// Shapes that used to slip through: a prefixed env name (the "_" before the
// keyword defeated the word boundary), URL userinfo, and HTTP auth headers.
const LEAKY = [
  ["DB_PASSWORD=hunter2hunter2", "hunter2hunter2", "DB_PASSWORD=‹redacted›"],
  ["export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI", "AWS_SECRET_ACCESS_KEY=‹redacted›"],
  ["STRIPE_SECRET_KEY=whsec9876543210abcdef", "whsec9876543210abcdef", "STRIPE_SECRET_KEY=‹redacted›"],
  ["connect to postgres://admin:pw@db.internal:5432/app", "admin:pw@", "postgres://admin:‹redacted›@db.internal:5432/app"],
  ["curl -H 'Authorization: Bearer abc123def456ghi789'", "abc123def456ghi789", "Authorization: Bearer ‹redacted›"],
  ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA", "Basic ‹redacted›"],
];
// Ordinary prose and identifiers that mention the keywords must survive.
const PROSE = [
  "the password is required",
  "password: required",
  "the auth flow uses bearer tokens now",
  "Bearer authentication is used for the API",
  "tokenizer=sentencepiece_v2_model",
  "see https://github.com/org/repo and http://localhost:4319/health",
  "git@github.com:aruntemme/reins.git",
];

test("masks prefixed env secrets, URL passwords and auth headers", () => {
  for (const [input, secret, expected] of LEAKY) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `secret gone: ${input} -> ${out}`);
    assert.ok(out.includes(expected), `kept the readable parts: ${out}`);
  }
});

test("does not over-redact ordinary prose that mentions secret keywords", () => {
  for (const s of PROSE) assert.equal(redactSecrets(s), s, `unchanged: ${s}`);
});
