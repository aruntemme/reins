"use client";
import type { SessionState, Who } from "@/lib/api";
import { initials } from "@/components/ui";
import { agentName, agentTag } from "./format";

/** One of four navy/blue tones per person, stable by member id. Pink and amber stay reserved for meaning. */
function hue(member: string): number {
  let h = 0;
  for (let i = 0; i < member.length; i++) h = (h * 31 + member.charCodeAt(i)) >>> 0;
  return h % 4;
}

export function Avatar({ who, size = 30, hidden }: { who: Who; size?: number; hidden?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`w-av w-av-${hue(who.member)}${hidden ? " w-av-ghost" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.35) }}
    >
      {hidden ? "" : initials(who.displayName || who.member)}
    </span>
  );
}

/** The agent's tile: CC / CX / OC / AI. */
export function AgentTile({ source, size = 26, state }: { source: string; size?: number; state?: SessionState }) {
  const tag = agentTag(source);
  const look = tag === "CC" ? "cc" : tag === "CX" ? "cx" : "oc";
  return (
    <span
      aria-hidden="true"
      className={`w-tile w-tile-${look}${state ? ` w-ring-${state}` : ""}`}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.36)) }}
    >
      {tag}
    </span>
  );
}

export function StateDot({ state }: { state: SessionState }) {
  return <span aria-hidden="true" className={`w-dot w-dot-${state}`} />;
}

/** "Claude Code · waiting" for a title/aria label. */
export function agentLabel(source: string, state: SessionState, extra?: string): string {
  return [agentName(source) || "Agent", extra, state].filter(Boolean).join(" · ");
}

export function SectionHead({ id, title, note, children }: { id: string; title: string; note?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="w-sec-h">
      <h2 id={id}>{title}</h2>
      {note && <span className="w-quiet">{note}</span>}
      {children}
    </div>
  );
}
