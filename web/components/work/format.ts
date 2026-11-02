import type { ItemKind, KindCounts, SessionState, Who } from "@/lib/api";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 24-hour wall clock, e.g. "11:58". */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "MONDAY · 11:58" */
export function dayLine(ts: number): string {
  return `${new Date(ts).toLocaleDateString([], { weekday: "long" }).toUpperCase()} · ${clock(ts)}`;
}

/** Short date, e.g. "Nov 14". */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A compact age: "now", "6m", "2h", "3d". */
export function ago(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < 24 * HOUR) return `${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / (24 * HOUR))}d`;
}

/** Hours as "21h" / "1.5h" / "0h". */
export function hours(h: number): string {
  if (!h) return "0h";
  return h >= 10 || Number.isInteger(h) ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
/** A count to start a sentence with: "One", "Two" … then digits. */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "3 features, 2 bug fixes, an experiment and a chore" (zero kinds left out). */
export function kindPhrase(c: KindCounts): string {
  const parts: string[] = [];
  if (c.feature) parts.push(c.feature === 1 ? "a feature" : `${c.feature} features`);
  if (c.bug) parts.push(c.bug === 1 ? "a bug fix" : `${c.bug} bug fixes`);
  if (c.try) parts.push(c.try === 1 ? "an experiment" : `${c.try} experiments`);
  if (c.chore) parts.push(c.chore === 1 ? "a chore" : `${c.chore} chores`);
  return andList(parts);
}

/** "owns 1 feature, 1 bug" */
export function ownsPhrase(c: KindCounts): string {
  const parts: string[] = [];
  if (c.feature) parts.push(plural(c.feature, "feature"));
  if (c.bug) parts.push(plural(c.bug, "bug"));
  if (c.try) parts.push(plural(c.try, "experiment"));
  if (c.chore) parts.push(plural(c.chore, "chore"));
  return parts.length ? `owns ${parts.join(", ")}` : "owns nothing yet";
}

export const KIND_LABEL: Record<ItemKind, string> = { feature: "Feature", bug: "Bug", try: "Trying out", chore: "Chore" };
export const KINDS: ItemKind[] = ["feature", "bug", "try", "chore"];

/** "Claude Code", "Codex", "OpenCode", "Aider" from a capture source id. */
export function agentName(source: string): string {
  const s = (source || "").toLowerCase();
  if (s.includes("claude")) return "Claude Code";
  if (s.includes("codex")) return "Codex";
  if (s.includes("opencode")) return "OpenCode";
  if (s.includes("aider")) return "Aider";
  if (s === "web" || !s) return "";
  return source;
}

/** Two-letter tile for an agent: CC, CX, OC, AI. */
export function agentTag(source: string): string {
  const s = (source || "").toLowerCase();
  if (s.includes("claude")) return "CC";
  if (s.includes("codex")) return "CX";
  if (s.includes("opencode")) return "OC";
  if (s.includes("aider")) return "AI";
  return (source || "?").slice(0, 2).toUpperCase();
}

/** "Ravi's Codex" for an agent post, or just "Ravi" for a person. */
export function voice(who: Who, source: string): string {
  const a = agentName(source);
  return a ? `${who.displayName}’s ${a}` : who.displayName;
}

export const STATE_LABEL: Record<SessionState, string> = {
  working: "working",
  waiting: "waiting",
  blocked: "blocked",
  idle: "idle",
  ended: "ended",
};

/** The last path segment of a worktree, e.g. "wt-refunds". */
export function base(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function greeting(ts: number): string {
  const h = new Date(ts).getHours();
  return h < 5 ? "Evening" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
}

/** Decode a route param once, tolerating values that are already decoded. */
export function param(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}
