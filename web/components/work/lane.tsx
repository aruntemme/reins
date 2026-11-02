"use client";
import Link from "next/link";
import type { ItemLane } from "@/lib/api";
import { AgentTile, Avatar, agentLabel } from "./bits";
import { KIND_LABEL, agentName } from "./format";

export const itemHref = (projectId: string, itemId: string) =>
  `/project/${encodeURIComponent(projectId)}/item/${encodeURIComponent(itemId)}`;

const stepsText = (l: ItemLane) =>
  l.steps.total ? `${l.steps.done} of ${l.steps.total} steps` : "no steps yet";

/** The rail an item travels along: a tick per step, the done part filled, its agents riding at their position. */
export function LaneTrack({ lane, ticks = true }: { lane: ItemLane; ticks?: boolean }) {
  const { done, total } = lane.steps;
  const dashed = lane.kind === "try" || lane.kind === "chore";
  const showTicks = ticks && total > 0 && total <= 24;
  const label = [
    stepsText(lane),
    ...lane.agents.map((a) => agentLabel(a.source, a.state)),
  ].join("; ");
  return (
    <div className="w-track" role="img" aria-label={label}>
      <span className="w-rail" />
      <span className={`w-flow${dashed ? " dashed" : ""}`} style={{ width: `${total ? (done * 96) / total : 0}%` }} />
      {showTicks && Array.from({ length: total }, (_, i) => (
        <span key={i} className={`w-tick${i < done ? " done" : ""}`} style={{ left: `calc(${((i + 0.5) * 96) / total}% - 4px)` }} />
      ))}
      {lane.agents.map((a, i) => {
        const at = Math.min(96, Math.max(2, (Number.isFinite(a.at) ? a.at : 0) * 96));
        return (
          <span
            key={a.sessionId}
            className="w-rider"
            title={agentLabel(a.source, a.state)}
            style={{ left: `calc(${at}% - 13px + ${i * 16}px)` }}
          >
            <AgentTile source={a.source} state={a.state} />
          </span>
        );
      })}
    </div>
  );
}

/** A full "who owns what" row: owner + title, the lane, and its state in words. */
export function LaneRow({ projectId, lane, showOwner = true }: { projectId: string; lane: ItemLane; showOwner?: boolean }) {
  const meta = [showOwner ? lane.owner.displayName : KIND_LABEL[lane.kind], lane.release?.title, stepsText(lane)].filter(Boolean).join(" · ");
  return (
    <div className="w-lane">
      <div className="w-lane-who">
        {showOwner && <Avatar who={lane.owner} />}
        <span className="w-lane-name">
          <Link href={itemHref(projectId, lane.id)} className="w-ink-link">{lane.title}</Link>
          <span className="w-meta">{meta}</span>
        </span>
      </div>
      <LaneTrack lane={lane} />
      <span className={`w-lane-state tone-${lane.state.tone}`}>{lane.state.text}</span>
    </div>
  );
}

/** A compact owned row (phone, My day, a person): title + state, a thin bar, the meta line. */
export function LaneCompact({ projectId, lane, showOwner = true }: { projectId: string; lane: ItemLane; showOwner?: boolean }) {
  const { done, total } = lane.steps;
  const dashed = lane.kind === "try" || lane.kind === "chore";
  const meta = [KIND_LABEL[lane.kind], showOwner ? lane.owner.displayName : null, lane.release?.title, total ? `${done} of ${total} steps` : null]
    .filter(Boolean).join(" · ");
  const agents = lane.agents.map((a) => agentName(a.source) || "agent").join(", ");
  return (
    <Link href={itemHref(projectId, lane.id)} className="w-compact">
      <span className="w-compact-top">
        {showOwner && <Avatar who={lane.owner} size={26} />}
        <span className="w-compact-name">
          <span className="w-compact-title">{lane.title}</span>
          <span className="w-meta">{meta}</span>
        </span>
      </span>
      <span className="w-compact-bar">
        <span className="w-minibar" aria-hidden="true">
          <span className={dashed ? "dashed" : ""} style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </span>
        <span className={`w-compact-state tone-${lane.state.tone}`}>
          {lane.state.text}
          {agents && <span className="w-sr"> · agents: {agents}</span>}
        </span>
      </span>
    </Link>
  );
}

/** "What you own" on My day: title and state, the lane with your agents on it, then the meta. */
export function LaneCard({ projectId, lane }: { projectId: string; lane: ItemLane }) {
  const meta = [KIND_LABEL[lane.kind], lane.release?.title, stepsText(lane)].filter(Boolean).join(" · ");
  return (
    <div className="w-lanecard">
      <div className="w-lanecard-top">
        <Link href={itemHref(projectId, lane.id)} className="w-ink-link w-strong">{lane.title}</Link>
        <span className={`w-small tone-${lane.state.tone}`}>{lane.state.text}</span>
      </div>
      <LaneTrack lane={lane} ticks={false} />
      <span className="w-meta">{meta}</span>
    </div>
  );
}
