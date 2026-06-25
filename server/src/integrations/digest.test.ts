import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// db.ts opens on import via the env.ts -> ... chain; isolate it on a temp file.
process.env.REINS_DB = join(tmpdir(), `reins-digest-${randomUUID()}.db`);

// env.ts reads the webhook URLs at import time, so configure them BEFORE the
// integration module is imported. The receiver runs on a port we know up front.
const slackPort = 4335;
const discordPort = 4336;
process.env.REINS_SLACK_WEBHOOK = `http://127.0.0.1:${slackPort}/slack`;
process.env.REINS_DISCORD_WEBHOOK = `http://127.0.0.1:${discordPort}/discord`;

const { formatSlack, formatDiscord, postDigest } = await import("./digest.js");
import type { Rollup } from "../pipeline/schemas.js";

const SAMPLE: Rollup = {
  summary: "Auth refactor landed; checkout flow still flaky under load.",
  alignment: "On track for the v2 launch goal, payments path is the risk.",
  collisions: [
    { area: "server/src/db.ts", members: ["asha", "ben"], note: "both editing schema" },
  ],
  risks: ["Checkout 500s under load", "No rollback plan for the migration"],
  handoffs: [],
};

// Start a one-shot capturing HTTP receiver on a fixed port. Resolves with the
// parsed body of the first POST it receives.
function receiver(port: number, path: string): { server: http.Server; got: Promise<{ method: string; body: unknown }> } {
  let resolveGot!: (v: { method: string; body: unknown }) => void;
  const got = new Promise<{ method: string; body: unknown }>((r) => {
    resolveGot = r;
  });
  const server = http.createServer((req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      resolveGot({ method: req.method || "", body });
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, got };
}

test("formatSlack produces a well-formed payload containing summary and risks", () => {
  const payload = formatSlack("proj1", "Project One", SAMPLE);
  const json = JSON.stringify(payload);
  assert.ok(Array.isArray(payload.blocks), "has blocks array");
  assert.ok(typeof payload.text === "string" && payload.text.length > 0, "has fallback text");
  assert.ok(json.includes(SAMPLE.summary), "contains summary");
  assert.ok(json.includes("Checkout 500s under load"), "contains a risk");
  assert.ok(json.includes("Project One"), "contains project name");
  assert.ok(!json.includes("\\u2014") && !json.includes("—"), "no em dashes");
});

test("formatDiscord produces a well-formed payload containing summary and risks", () => {
  const payload = formatDiscord("proj1", "Project One", SAMPLE);
  const json = JSON.stringify(payload);
  assert.ok(Array.isArray(payload.embeds), "has embeds array");
  assert.ok(typeof payload.content === "string" && payload.content.length > 0, "has content fallback");
  assert.ok(json.includes(SAMPLE.summary), "contains summary");
  assert.ok(json.includes("No rollback plan for the migration"), "contains a risk");
});

test("postDigest delivers a real POST to a Slack webhook receiver", async () => {
  const slack = receiver(slackPort, "/slack");
  const discord = receiver(discordPort, "/discord");
  try {
    const result = await postDigest("proj1", "Project One", SAMPLE);
    assert.equal(result.slack, true, "slack reported success");
    assert.equal(result.discord, true, "discord reported success");

    const slackHit = await slack.got;
    assert.equal(slackHit.method, "POST");
    const sbody = slackHit.body as Record<string, unknown>;
    assert.ok(JSON.stringify(sbody).includes(SAMPLE.summary), "slack body has the summary");
    assert.ok(Array.isArray(sbody.blocks), "slack body has blocks");

    const discordHit = await discord.got;
    assert.equal(discordHit.method, "POST");
    const dbody = discordHit.body as Record<string, unknown>;
    assert.ok(JSON.stringify(dbody).includes(SAMPLE.summary), "discord body has the summary");
    assert.ok(Array.isArray(dbody.embeds), "discord body has embeds");
  } finally {
    slack.server.close();
    discord.server.close();
  }
});
