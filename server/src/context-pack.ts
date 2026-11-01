/**
 * Context Pack — the canonical, portable representation of a project's shared
 * context. This is the exact object the MCP `reins_context` tool renders to
 * answer an agent, and the unit cross-instance merge operates on.
 */
import { getProject, listMembers, listPending, getRollup, recentTimeline } from "./db.js";

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

/** Very light stemming so "tests"/"testing"/"tested" meet "test", and
 *  "fixes" meets "fix". Deliberately conservative (no dictionary). */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Split paths/punctuation into words, lowercase, drop stop words, and lightly
 *  stem. With `parts`, a camelCase word also yields its pieces, so
 *  "src/authFlow.ts" → ["src", "authflow", "auth", "flow", "ts"]. Documents are
 *  tokenized with parts; queries without (a query "auth" still finds "authFlow"). */
export function tokenize(text: string, parts = true): string[] {
  const out: string[] = [];
  for (const word of (text || "").split(/[^A-Za-z0-9]+/)) {
    if (!word) continue;
    out.push(word.toLowerCase());
    if (!parts) continue;
    const pieces = word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ");
    if (pieces.length > 1) out.push(...pieces.map((p) => p.toLowerCase()));
  }
  return out.filter((t) => t.length > 1 && !STOP_WORDS.has(t)).map(stem);
}

/**
 * Inverse document frequency of every term across a set of documents: terms in
 * nearly every document ("src", "ts", "server") weigh almost nothing, rare ones
 * weigh most. idf = ln((N + 1) / df); a term in no document gets the max weight.
 */
export function idfWeights(docs: string[]): (term: string) => number {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(tokenize(d))) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return (t) => Math.log((n + 1) / (df.get(t) || 1));
}

/**
 * Pure, unit-testable relevance score of `text` against `query`. Higher = more
 * relevant, in [0, 1]: the IDF-weighted share of distinct query terms present in
 * the text (unweighted when no `idf` is given). Returns 0 for an empty query
 * (neutral — caller falls back to recency ordering). Lexical on purpose, so it
 * can later be swapped for an embedding similarity without touching ranking.
 */
export function scoreRelevance(text: string, query: string, idf?: (term: string) => number): number {
  const terms = new Set(tokenize(query, false));
  if (terms.size === 0) return 0; // empty query is neutral
  const weight = idf ?? (() => 1);
  const haystack = new Set(tokenize(text));
  let hit = 0;
  let total = 0;
  for (const term of terms) {
    const w = weight(term);
    total += w;
    if (haystack.has(term)) hit += w;
  }
  return total > 0 ? hit / total : 0;
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
  const pack = buildContextPack(project);
  // A member's recent timeline is searchable too (what they just did often
  // matches a task better than their one-line headline). Only needed to rank.
  const recent: Record<string, string> = {};
  if (opts.query) {
    for (const m of pack.members) {
      recent[m.member] = recentTimeline(project, m.member, 5).map((t: any) => t.summary).join(" ");
    }
  }
  return scopePack(pack, opts, recent);
}

/**
 * Apply scoping to an already-built pack in memory. Split out from
 * buildScopedContextPack so a caller that already holds a full pack can scope it
 * without rebuilding from the DB.
 */
export function scopePack(
  pack: ContextPack,
  opts: ScopeOptions = {},
  /** Extra searchable text per member id (e.g. recent timeline), used only for ranking. */
  extra: Record<string, string> = {}
): ContextPack {
  const { member, query, limit } = opts;
  const focus = (member || "").trim().toLowerCase();
  const searchText = (m: ContextPack["members"][number]) => `${memberText(m)} ${extra[m.member] ?? ""}`;
  const pendingText = (p: ContextPack["pending"][number]) => `${p.text} ${p.member}`;
  // Weight query terms by how rare they are across this pack's documents.
  const idf = query
    ? idfWeights([...pack.members.map(searchText), ...pack.pending.map(pendingText)])
    : undefined;

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
      score: query ? scoreRelevance(searchText(m), query, idf) : 0,
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
      score: query ? scoreRelevance(pendingText(p), query, idf) : 0,
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
