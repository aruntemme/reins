/**
 * Context Pack — the canonical, portable representation of a project's shared
 * context. This is the exact object that gets written to 0G Storage on every
 * rollup, and the exact object the MCP `reins_context` tool reads back FROM 0G
 * Storage (verified by its Merkle root hash) to answer an agent.
 *
 * Because the retrieval path deserializes this pack straight from 0G Storage,
 * 0G Storage is load-bearing: remove it and cross-agent context retrieval stops
 * returning the verifiable shared brain.
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

/** Render a pack to the markdown an agent reads. `source` notes where it came from. */
export function renderContextPack(
  pack: ContextPack,
  source?: { from: "0g-storage" | "local"; rootHash?: string; url?: string; note?: string }
): string {
  const lines: string[] = [];
  const verified =
    source?.from === "0g-storage"
      ? " (retrieved from 0G Storage, Merkle-verified)"
      : "";
  lines.push(`# ${pack.name} — shared context${verified}`);
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

  if (source?.rootHash) {
    lines.push(
      `\n## Provenance\nSource: 0G Storage · root hash ${source.rootHash}` +
        (source.url ? `\n${source.url}` : "")
    );
  }
  if (source?.note) lines.push(`\n_${source.note}_`);
  return lines.join("\n");
}
