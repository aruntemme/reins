"use client";
import Link from "next/link";
import type { ClipKind, Need, TodayData } from "@/lib/api";
import { Avatar } from "./bits";
import { agentName, ago, clock, voice } from "./format";
import { itemHref } from "./lane";

const LABEL_W = 260;
const HEAD_H = 36;
const ROW_H = 48;
const HOUR = 3_600_000;

export const LEGEND: { kind: ClipKind; name: string }[] = [
  { kind: "feature", name: "Feature" },
  { kind: "bug", name: "Bug fix" },
  { kind: "try", name: "Trying out" },
  { kind: "chore", name: "Chore or review" },
  { kind: "wait", name: "Waiting on someone" },
  { kind: "block", name: "Blocked" },
];

export function Legend({ kinds = LEGEND }: { kinds?: { kind: ClipKind; name: string }[] }) {
  return (
    <ul className="w-legend" aria-label="Legend">
      {kinds.map((l) => (
        <li key={l.kind}><span aria-hidden="true" className={`w-swatch k-${l.kind}`} />{l.name}</li>
      ))}
    </ul>
  );
}

/** Last two path segments: "proctor/session.ts". */
const shortPath = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/");

/** "Today, by agent": one row per agent session, each block a task tinted by its kind, a line at now. */
export function Tracks({ projectId, tracks, needs, now }: { projectId: string; tracks: TodayData["tracks"]; needs: Need[]; now: number }) {
  const { from, rows, overlaps } = tracks;
  const to = Math.max(tracks.to, from + HOUR);
  const at = now || tracks.now;
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - from) / (to - from)) * 100));

  const hourMarks: number[] = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) hourMarks.push(t);
  // Keep labels readable on long windows.
  const every = Math.max(1, Math.ceil(hourMarks.length / 10));

  const rowTop = (i: number) => HEAD_H + i * ROW_H;
  const question = needs.find((n) => n.type === "question" && n.sessionId && rows.some((r) => r.sessionId === n.sessionId));
  const qRow = question ? rows.findIndex((r) => r.sessionId === question.sessionId) : -1;
  const qAbove = qRow >= 0 && qRow >= rows.length - 2 && qRow >= 2;
  const qTop = qRow < 0 ? 0 : qAbove ? rowTop(qRow) - 92 : rowTop(qRow + 1) - 4;
  const qLeft = Math.min(pct(at) / 100, 0.7);
  const minH = Math.max(HEAD_H + rows.length * ROW_H, qRow >= 0 ? qTop + 100 : 0);

  return (
    <div className="w-tracks-box">
      <div className="w-tracks" style={{ minHeight: minH }}>
        <div className="w-tracks-head" aria-hidden="true">
          <span style={{ flex: `0 0 ${LABEL_W}px` }} />
          <div className="w-tracks-hours">
            {hourMarks.map((t, i) => (i % every === 0 ? (
              <span key={t} style={{ left: `calc(${pct(t)}% + ${pct(t) > 94 ? -42 : 6}px)` }}>{clock(t)}</span>
            ) : null))}
          </div>
        </div>
        <ol className="w-tracks-rows">
          {rows.map((r, i) => {
            const first = i === 0 || rows[i - 1].who.member !== r.who.member;
            const agent = agentName(r.source) || "Agent";
            return (
              <li key={r.sessionId} className={`w-trow${first ? " first" : ""}`}>
                <div className="w-trow-who" style={{ flex: `0 0 ${LABEL_W}px` }} title={r.worktree || undefined}>
                  <Avatar who={r.who} size={24} hidden={!first} />
                  <span className="w-trow-name">
                    <span>{r.who.displayName} · {agent}</span>
                    <span className="w-mono w-meta w-ellipsis">{r.branch || "no branch"}</span>
                  </span>
                </div>
                <div className="w-trow-clips">
                  {r.clips.map((c, j) => {
                    const end = c.to ?? at;
                    const left = pct(c.from);
                    const width = Math.max(0.6, pct(end) - left);
                    const label = `${c.label} · ${clock(c.from)}–${c.to ? clock(c.to) : "now"}`;
                    const cls = `w-clip k-${c.kind}${c.to == null ? " live" : ""}`;
                    const style = { left: `${left}%`, width: `${width}%` };
                    return c.itemId ? (
                      <Link key={j} href={itemHref(projectId, c.itemId)} className={cls} style={style} title={label} aria-label={`${r.who.displayName}’s ${agent}: ${label}`}>{c.label}</Link>
                    ) : (
                      <span key={j} className={cls} style={style} title={label}><span className="w-sr">{r.who.displayName}’s {agent}: </span>{c.label}</span>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="w-tracks-over" aria-hidden="true" style={{ left: LABEL_W }}>
          {hourMarks.map((t) => <span key={t} className="w-gridline" style={{ left: `${pct(t)}%`, top: HEAD_H }} />)}
          {overlaps.map((o, k) => {
            const idx = rows.map((r, i) => (o.members.some((m) => m.member === r.who.member) ? i : -1)).filter((i) => i >= 0);
            if (idx.length === 0) return null;
            const top = rowTop(Math.min(...idx)) + 6;
            const bottom = rowTop(Math.max(...idx) + 1) - 6;
            const x = pct(o.at);
            return (
              <span key={k}>
                <span className="w-overlap-line" style={{ left: `${x}%`, top, height: bottom - top }} />
                <span className="w-overlap-chip" style={{ left: `calc(${x}% + 6px)`, top: top + (bottom - top) / 2 - 10 }}>
                  {o.members.length === 2 ? "both" : `${o.members.length}`} in {shortPath(o.path)}
                </span>
              </span>
            );
          })}
          <span className="w-nowline" style={{ left: `${pct(at)}%`, top: HEAD_H - 8 }} />
          <span className="w-nowchip" style={{ left: `calc(${pct(at)}% - 26px)` }}>{clock(at)}</span>
        </div>
        {question && (
          <div className="w-callout" style={{ top: qTop, left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${qLeft})` }}>
            <span className="w-callout-k">{voice(question.from, question.from.source)} asked you · {ago(question.at, at)}</span>
            <span>{question.text}</span>
            <a href="#needs" className="w-link-strong">Answer</a>
          </div>
        )}
      </div>
    </div>
  );
}
