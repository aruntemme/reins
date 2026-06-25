#!/usr/bin/env node
/**
 * Reins autonomous claimer agent — agents act on the shared context with no
 * human in the loop. It watches a project's open ("up for grabs") pending work,
 * claims the items a policy matches, resolves them, then posts a single
 * source:"auto" note summarising what it did.
 *
 * Dependency-free: only Node built-ins, so it ships as a thin `npx` binary with
 * nothing to install. Every unit of behaviour is exported so it can be exercised
 * end-to-end against a real server in tests — no stubs.
 *
 * Bearer auth is opt-in: when a token is supplied we send
 * `Authorization: Bearer <token>`, which is harmless when the server runs with
 * auth off and required when it is on.
 */

const DEFAULT_URL = "http://localhost:4319";
const SOURCE = "auto"; // every write this agent makes is tagged so humans can tell it apart.

/** Build request headers, attaching a bearer token only when one is present. */
function headers(token) {
  const h = { "content-type": "application/json" };
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

function trimUrl(url) {
  return (url || DEFAULT_URL).replace(/\/$/, "");
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Decide which of the open pending items to act on.
 *  - policy "all" (or empty/undefined): every open item.
 *  - otherwise the policy is treated as a JS regex matched against item.text.
 * Pure and side-effect free so it can be unit tested in isolation.
 *
 * @param {Array<{id:string,text:string,status?:string}>} items
 * @param {string} [policy]
 * @returns {Array} the subset to claim
 */
export function selectItems(items, policy) {
  const open = (items || []).filter((it) => !it.status || it.status === "open");
  if (!policy || policy === "all" || policy === "*") return open;
  let re;
  try {
    re = new RegExp(policy, "i");
  } catch (err) {
    throw new Error(`invalid --policy regex ${JSON.stringify(policy)}: ${err.message}`);
  }
  return open.filter((it) => re.test(String(it.text ?? "")));
}

/** GET the project's open pending items from the dedicated endpoint. */
export async function fetchOpenPending({ url, token, project }) {
  const res = await fetch(`${trimUrl(url)}/api/projects/${encodeURIComponent(project)}/pending`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`fetchOpenPending ${res.status}`);
  const data = await readJson(res);
  return Array.isArray(data?.pending) ? data.pending : [];
}

/** Claim one pending item for `by`. */
export async function claimItem({ url, token, project, id, by }) {
  const res = await fetch(`${trimUrl(url)}/api/pending/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ project, by }),
  });
  if (!res.ok) throw new Error(`claimItem ${id} ${res.status}`);
  return (await readJson(res)) ?? { ok: true };
}

/** Mark one pending item done. */
export async function resolveItem({ url, token, project, id }) {
  const res = await fetch(`${trimUrl(url)}/api/pending/${encodeURIComponent(id)}/done`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ project }),
  });
  if (!res.ok) throw new Error(`resolveItem ${id} ${res.status}`);
  return (await readJson(res)) ?? { ok: true };
}

/** Post a source:"auto" note to the project timeline. */
export async function note({ url, token, project, member, text }) {
  const res = await fetch(`${trimUrl(url)}/api/ingest`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      project,
      member,
      kind: "progress",
      text,
      source: SOURCE,
      meta: { source: SOURCE },
    }),
  });
  if (!res.ok) throw new Error(`note ${res.status}`);
  return (await readJson(res)) ?? { ok: true };
}

/**
 * One pass: read open pending, pick the matching items, claim + resolve each,
 * then post a single source:"auto" note. In dry-run nothing is mutated — it
 * only reports what it WOULD do.
 *
 * @returns {Promise<{matched:Array, claimed:string[], resolved:string[], dryRun:boolean, noted:boolean}>}
 */
export async function runOnce({ url, token, project, by, policy, dryRun = false, log = () => {} }) {
  const actor = by || "auto-agent";
  const open = await fetchOpenPending({ url, token, project });
  const matched = selectItems(open, policy);

  if (dryRun) {
    for (const it of matched) log(`[dry-run] would claim+resolve ${it.id}: ${String(it.text ?? "").slice(0, 80)}`);
    if (!matched.length) log("[dry-run] no matching open pending items");
    return { matched, claimed: [], resolved: [], dryRun: true, noted: false };
  }

  const claimed = [];
  const resolved = [];
  for (const it of matched) {
    await claimItem({ url, token, project, id: it.id, by: actor });
    claimed.push(it.id);
    log(`claimed ${it.id}`);
    await resolveItem({ url, token, project, id: it.id });
    resolved.push(it.id);
    log(`resolved ${it.id}`);
  }

  let noted = false;
  if (resolved.length) {
    const summary =
      resolved.length === 1
        ? `Auto-claimed and resolved 1 pending item (${matched[0].text?.slice(0, 60) ?? ""}).`
        : `Auto-claimed and resolved ${resolved.length} pending items.`;
    await note({ url, token, project, member: actor, text: summary });
    noted = true;
  }

  return { matched, claimed, resolved, dryRun: false, noted };
}

// ── CLI ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { interval: 0, once: false, dryRun: false, policy: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": out.url = next(); break;
      case "--token": out.token = next(); break;
      case "--project": out.project = next(); break;
      case "--by": out.by = next(); break;
      case "--policy": out.policy = next(); break;
      case "--interval": out.interval = Number(next()); break;
      case "--once": out.once = true; break;
      case "--dry-run": out.dryRun = true; break;
      case "-h":
      case "--help": out.help = true; break;
      default:
        if (a?.startsWith("--")) throw new Error(`unknown flag ${a}`);
    }
  }
  return out;
}

const HELP = `reins-agent — autonomous claimer for Reins pending work

Usage:
  reins-agent --project <id> [options]

Options:
  --url <url>        Reins server (default ${DEFAULT_URL} or $REINS_URL)
  --token <token>    bearer token (default $REINS_TOKEN), sent only if present
  --project <id>     project to watch (required)
  --by <member>      who to claim as (default $REINS_MEMBER or "auto-agent")
  --policy <p>       "all" (default) or a regex matched against item text
  --dry-run          report what it would claim, change nothing
  --once             run a single pass and exit
  --interval <sec>   poll every <sec> seconds (ignored with --once)
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const cfg = {
    url: opts.url || process.env.REINS_URL || DEFAULT_URL,
    token: opts.token || process.env.REINS_TOKEN,
    project: opts.project,
    by: opts.by || process.env.REINS_MEMBER || "auto-agent",
    policy: opts.policy,
    dryRun: opts.dryRun,
    log: (m) => console.log(m),
  };
  if (!cfg.project) {
    console.error("--project is required");
    process.exit(2);
  }

  const tick = async () => {
    try {
      const r = await runOnce(cfg);
      if (!cfg.dryRun) {
        console.log(`pass done: ${r.resolved.length} resolved of ${r.matched.length} matched`);
      }
    } catch (err) {
      console.error(`pass failed: ${err.message}`);
    }
  };

  if (opts.once || !opts.interval) {
    await tick();
    return;
  }
  // Loop forever until the process is signalled. Each pass is independent.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await sleep(opts.interval * 1000);
  }
}

// Import-safe: only run the CLI when invoked directly, never on import (tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
