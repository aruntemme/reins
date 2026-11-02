"use client";
import type { WorkPart } from "@/lib/api";

export const PART_LEGEND: { kind: WorkPart["kind"]; name: string }[] = [
  { kind: "feature", name: "Feature" },
  { kind: "bug", name: "Bug fix" },
  { kind: "try", name: "Trying out" },
  { kind: "chore", name: "Chore or review" },
  { kind: "blocked", name: "Blocked or waiting" },
];

/** A day key from the server (ISO date or epoch ms) as a Date at local noon. */
export function dayOf(d: string | number): Date {
  if (typeof d === "number") return new Date(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : new Date(d);
}
export const weekday = (d: string | number) => dayOf(d).toLocaleDateString([], { weekday: "short" });

export function PartsLegend({ kinds = PART_LEGEND }: { kinds?: typeof PART_LEGEND }) {
  return (
    <ul className="w-legend" aria-label="Legend">
      {kinds.map((l) => <li key={l.kind}><span aria-hidden="true" className={`w-swatch p-${l.kind}`} />{l.name}</li>)}
    </ul>
  );
}

