import { env } from "../env.js";
import type { Rollup } from "../pipeline/schemas.js";

// The pipeline passes the zod-inferred rollup, whose optional list fields differ
// between input and output inference. We only read a stable subset, so accept any
// shape that carries those fields. Keeps the digest decoupled from schema churn.
type DigestRollup = Pick<Rollup, "summary" | "alignment"> & {
  risks?: Rollup["risks"];
  collisions?: Rollup["collisions"];
};

// Observability for the fire-and-forget digest posts. The pipeline never awaits
// these, so this is the only place that records whether a post landed.
export const digestStats = {
  posts: 0,
  lastError: "" as string,
};

// Cap how much of each list we surface so a digest stays scannable in chat.
const MAX_RISKS = 5;
const MAX_COLLISIONS = 5;

function topRisks(rollup: DigestRollup): string[] {
  return (rollup.risks ?? []).slice(0, MAX_RISKS);
}

function collisionLines(rollup: DigestRollup): string[] {
  return (rollup.collisions ?? []).slice(0, MAX_COLLISIONS).map((c) => {
    const who = c.members?.length ? c.members.join(", ") : "team";
    return `${c.area}: ${who}${c.note ? ` (${c.note})` : ""}`;
  });
}

// Slack Block Kit payload. We use blocks for structure but also keep a top-level
// "text" as the notification fallback (required for accessibility/notifications).
export function formatSlack(project: string, name: string, rollup: DigestRollup): Record<string, unknown> {
  const risks = topRisks(rollup);
  const collisions = collisionLines(rollup);

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `Reins digest: ${name || project}`, emoji: false },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary*\n${rollup.summary || "(no summary)"}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Goal alignment*\n${rollup.alignment || "(not assessed)"}` },
    },
  ];

  if (risks.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Top risks*\n${risks.map((r) => `- ${r}`).join("\n")}` },
    });
  }
  if (collisions.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Collisions*\n${collisions.map((c) => `- ${c}`).join("\n")}` },
    });
  }

  return {
    text: `Reins digest for ${name || project}: ${rollup.summary || "(no summary)"}`,
    blocks,
  };
}

// Discord webhook payload. Discord rejects empty embeds, so we always include a
// "content" fallback alongside a single rich embed.
export function formatDiscord(project: string, name: string, rollup: DigestRollup): Record<string, unknown> {
  const risks = topRisks(rollup);
  const collisions = collisionLines(rollup);

  const fields: Array<Record<string, unknown>> = [
    { name: "Goal alignment", value: rollup.alignment || "(not assessed)" },
  ];
  if (risks.length) {
    fields.push({ name: "Top risks", value: risks.map((r) => `- ${r}`).join("\n") });
  }
  if (collisions.length) {
    fields.push({ name: "Collisions", value: collisions.map((c) => `- ${c}`).join("\n") });
  }

  return {
    content: `Reins digest for ${name || project}`,
    embeds: [
      {
        title: `Reins digest: ${name || project}`,
        description: rollup.summary || "(no summary)",
        fields,
      },
    ],
  };
}

// POST a JSON payload to a webhook with a short timeout. Returns true on a 2xx.
// Never throws: webhook outages must not break the rollup pipeline.
async function post(url: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.ok) {
      digestStats.posts++;
      return true;
    }
    digestStats.lastError = `${url.includes("discord") ? "discord" : "slack"} returned ${res.status}`;
    return false;
  } catch (e) {
    digestStats.lastError = (e as Error)?.message || String(e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Post a rollup digest to whichever webhooks are configured. No-op (resolves to
// an empty object) when neither is set. Errors are swallowed and recorded in
// digestStats so a flaky webhook never breaks rollup synthesis.
export async function postDigest(
  project: string,
  name: string,
  rollup: DigestRollup
): Promise<{ slack?: boolean; discord?: boolean }> {
  const out: { slack?: boolean; discord?: boolean } = {};
  const jobs: Array<Promise<void>> = [];

  if (env.integrations.slackWebhook) {
    jobs.push(
      post(env.integrations.slackWebhook, formatSlack(project, name, rollup)).then((ok) => {
        out.slack = ok;
      })
    );
  }
  if (env.integrations.discordWebhook) {
    jobs.push(
      post(env.integrations.discordWebhook, formatDiscord(project, name, rollup)).then((ok) => {
        out.discord = ok;
      })
    );
  }

  await Promise.all(jobs);
  return out;
}
