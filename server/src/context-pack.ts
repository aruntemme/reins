/**
 * Context Pack — the canonical, portable representation of a project's shared
 * context. This is the exact object the MCP `reins_context` tool renders to
 * answer an agent, and the unit cross-instance merge operates on.
 */
import { getProject, listMembers, listPending, getRollup } from "./db.js";

export interface ContextPack {
  v: 1;
  project: string;
  name: string;
  goal: string;
  generatedAt: number;
  members: {
    member: string;
    name: string;
    status: string;
    headline: string;
    goal: string;
    workingOn: string[];
  }[];
  pending: { member: string; text: string; status: string }[];
  rollup: {
    summary: string;
    alignment: string;
    collisions: { area: string; members: string[]; note?: string }[];
    risks: string[];
  } | null;
}

function parseArr(s: unknown): any[] {
  if (Array.isArray(s)) return s;
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Build the pack from the live DB (used by the rollup writer before upload). */
export function buildContextPack(project: string): ContextPack {
  const proj = getProject(project);
  const members = listMembers(project);
  const pending = listPending(project);
  const r: any = getRollup(project);

  return {
    v: 1,
    project,
    name: proj?.name || project,
    goal: proj?.goal || "",
    generatedAt: Date.now(),
    members: members.map((m: any) => ({
      member: m.member,
      name: m.display_name || m.member,
      status: m.status,
      headline: m.headline || "",
      goal: m.goal || "",
      workingOn: parseArr(m.working_on),
    })),
    pending: pending.map((p: any) => ({ member: p.member, text: p.text, status: p.status })),
    rollup: r
      ? {
          summary: r.summary || "",
          alignment: r.alignment || "",
          collisions: parseArr(r.collisions),
          risks: parseArr(r.risks),
        }
      : null,
  };
}

// ── Scoped retrieval (Workstream E) ───────────────────────────────
// reins_context returns the whole pack today; for large teams that floods an
// agent's window with context it doesn't need. buildScopedContextPack ranks +
// trims the pack so an agent can pull only what's relevant to its task, while
// buildContextPack stays byte-for-byte the same for the rollup/storage path.

export interface ScopeOptions {
  /** Focus on this member id or display name: it ranks first and survives trimming. */
  member?: string;
  /** Free-text task description; members + pending are ranked by overlap with it. */
  query?: string;
  /**
   * Approximate token budget for the members + pending arrays combined.
   * Tokens are approximated as chars / 4. The rollup + goal are always kept;
   * only the member/pending lists are trimmed to fit. Unset = no trimming.
   */
  limit?: number;
}

// Words that carry no topical signal — dropping them keeps overlap scoring honest
// (a query like "the auth flow" shouldn't reward members who say "the" a lot).
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "at", "by", "it", "as", "this", "that", "i", "we", "you",
  "my", "our", "your", "im", "ive", "re",
]);

/** Lowercase + split into meaningful word tokens (drops punctuation + stop words). */
export function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Pure, unit-testable relevance score of `text` against `query`. Higher = more
 * relevant. Counts distinct query terms that appear in the text, normalized by
 * the number of query terms so longer queries don't inflate scores. Returns 0
 * for an empty query (neutral — caller falls back to recency ordering). This is
 * deliberately a small lexical function so it can later be swapped for an
 * embedding similarity without touching the ranking/trimming logic.
 */
export function scoreRelevance(text: string, query: string): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0; // empty query is neutral
  const haystack = new Set(tokenize(text));
  let hits = 0;
  for (const term of new Set(terms)) {
    if (haystack.has(term)) hits++;
  }
  return hits / new Set(terms).size;
}

/** All searchable text for a member, concatenated for scoring. */
function memberText(m: ContextPack["members"][number]): string {
  return [m.name, m.member, m.headline, m.goal, ...m.workingOn].join(" ");
}

/** Rough token estimate (chars / 4) of one rendered member/pending line. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Produce a ranked, trimmed copy of a project's pack. Back-compat: this is a
 * superset of buildContextPack — with no options it returns the same data,
 * just rebuilt as a fresh object. The rollup summary and goal are NEVER trimmed
 * (they're the cheapest, highest-signal context); only the members + pending
 * arrays are reordered and capped.
 */
export function buildScopedContextPack(project: string, opts: ScopeOptions = {}): ContextPack {
  return scopePack(buildContextPack(project), opts);
}

/**
 * Apply scoping to an already-built pack in memory. Split out from
 * buildScopedContextPack so a caller that already holds a full pack can scope it
 * without rebuilding from the DB.
 */
export function scopePack(pack: ContextPack, opts: ScopeOptions = {}): ContextPack {
  const { member, query, limit } = opts;
  const focus = (member || "").trim().toLowerCase();

  const isFocus = (m: ContextPack["members"][number]) =>
    focus !== "" &&
    (m.member.toLowerCase() === focus || (m.name || "").toLowerCase() === focus);

  // Stable rank: focused member first, then descending relevance, then preserve
  // the incoming order (already recency-sorted by the DB) as the tiebreaker.
  const rankedMembers = pack.members
    .map((m, i) => ({
      m,
      i,
      focus: isFocus(m),
      score: query ? scoreRelevance(memberText(m), query) : 0,
    }))
    .sort((a, b) => {
      if (a.focus !== b.focus) return a.focus ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.i - b.i; // recency tiebreaker
    })
    .map((x) => x.m);

  const rankedPending = pack.pending
    .map((p, i) => ({
      p,
      i,
      focus: focus !== "" && (p.member || "").toLowerCase() === focus,
      score: query ? scoreRelevance(`${p.text} ${p.member}`, query) : 0,
    }))
    .sort((a, b) => {
      if (a.focus !== b.focus) return a.focus ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.i - b.i;
    })
    .map((x) => x.p);

  let members = rankedMembers;
  let pending = rankedPending;

  // Trim to the token budget. Members are higher value than pending (an agent
  // wants to know who's doing what before it scans the up-for-grabs list), so we
  // fill members first, then spend any remaining budget on pending. A focused
  // member is always kept even if it alone blows the budget.
  if (typeof limit === "number" && limit > 0) {
    let used = 0;
    const keptMembers: typeof members = [];
    for (const m of rankedMembers) {
      const cost = approxTokens(memberText(m));
      if (keptMembers.length > 0 && used + cost > limit && !isFocus(m)) break;
      keptMembers.push(m);
      used += cost;
    }
    const keptPending: typeof pending = [];
    for (const p of rankedPending) {
      const cost = approxTokens(`${p.text} ${p.member}`);
      if (used + cost > limit) break;
      keptPending.push(p);
      used += cost;
    }
    members = keptMembers;
    pending = keptPending;
  }

  return { ...pack, members, pending };
}

/** Render a pack to the markdown an agent reads. `source` notes where it came from. */
export function renderContextPack(
  pack: ContextPack,
  source?: { from: "local"; note?: string }
): string {
  const lines: string[] = [];
  lines.push(`# ${pack.name} — shared context`);
  lines.push(`Goal: ${pack.goal || "(not set)"}`);

  if (pack.rollup) {
    lines.push(`\n## Status\n${pack.rollup.summary}`);
    if (pack.rollup.alignment) lines.push(`Alignment: ${pack.rollup.alignment}`);
    if (pack.rollup.risks?.length) lines.push(`Risks: ${pack.rollup.risks.join("; ")}`);
    if (pack.rollup.collisions?.length)
      lines.push(
        `Collisions: ${pack.rollup.collisions
          .map((c) => `${c.area} (${(c.members || []).join(", ")})`)
          .join("; ")}`
      );
  }

  lines.push(`\n## Team`);
  for (const m of pack.members) {
    lines.push(
      `- ${m.name} [${m.status}] — ${m.headline || "(idle)"}` +
        (m.workingOn.length ? `\n    on: ${m.workingOn.join(", ")}` : "")
    );
  }

  const open = pack.pending.filter((p) => p.status !== "done");
  lines.push(`\n## Pending / up for grabs`);
  lines.push(open.map((p) => `- [${p.status}] (${p.member}) ${p.text}`).join("\n") || "(none)");

  if (source?.note) lines.push(`\n_${source.note}_`);
  return lines.join("\n");
}
