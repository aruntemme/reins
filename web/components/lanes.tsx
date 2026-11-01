"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { timeAgo, type Collision, type Member, type Project } from "@/lib/api";
import { initials } from "@/components/ui";

export const WINDOW_MS = 60 * 60_000;
const MIN = 60_000;
// An edit this recent by a live agent is "editing now".
const NOW_MS = 10 * MIN;
// A single touch is drawn as this much work; consecutive touches chain.
const FIRST_SEG_MS = 4 * MIN;
const MAX_SEG_MS = 15 * MIN;
const MIN_SEG_MS = 2 * MIN;
const ROW_H = 84;

const MERGED = /\b(?:merged|landed)\b/i;
const HEDGED = /\b(?:not|n't|once|until|before|after|when|if|unless|ready to|waiting|awaiting|to be|should be|will be)\b[^\n.]{0,20}\b(?:merged|landed)\b/i;
const COMMIT = /\bcommit(?:ted|s)?\b/i;

/** Re-renders every `ms` so the lanes slide with the clock. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** "25m", "3h", "2d": timeAgo without the " ago". */
export const span = (ts: number) => timeAgo(ts).replace(/ ago$/, "");
export const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
const samePath = (a: string, b: string) => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};
export const isBranchArea = (area: string) => /^branch /.test(area) || area === "the same branch";

/** Member ids a collision names (it carries display names). */
export function collisionIds(c: Collision, members: Member[]): string[] {
  return c.members
    .map((n) => members.find((m) => m.displayName === n || m.member === n)?.member)
    .filter((x): x is string => !!x);
}

/** When the overlap was caught: the collision handoff Reins sent, else when the second agent arrived. */
export function caughtAt(c: Collision, members: Member[]): { at: number; sent: boolean } | null {
  const ids = collisionIds(c, members);
  const sent = members
    .filter((m) => ids.includes(m.member))
    .flatMap((m) => m.handoffs)
    .filter((h) => h.kind === "collision" && (!h.from || ids.includes(h.from)))
    .map((h) => h.createdAt);
  if (sent.length) return { at: Math.min(...sent), sent: true };
  if (isBranchArea(c.area)) return null;
  const arrivals = members
    .filter((m) => ids.includes(m.member))
    .map((m) => m.touches.find((t) => samePath(t.path, c.area))?.at)
    .filter((x): x is number => !!x);
  return arrivals.length ? { at: Math.max(...arrivals), sent: false } : null;
}

/** Since when a blocked member has been blocked (their latest "blocked" timeline entry). */
export function blockedSince(m: Member): { at: number; why: string } | null {
  if (m.displayStatus !== "blocked") return null;
  const b = m.timeline.find((t) => t.kind === "blocked");
  return b ? { at: b.at, why: b.summary } : null;
}

type Seg = { kind: "edit" | "now" | "blocked"; from: number; to: number; label: string; title: string; overlap: boolean };
type Dot = { kind: "commit" | "merge" | "update"; at: number; title: string };
export type Lane = { segs: Seg[]; dots: Dot[]; away: boolean; current: string | null; blocked: { at: number | null; why: string } | null };

export function laneOf(m: Member, now: number, overlapPaths: string[]): Lane {
  const start = now - WINDOW_MS;
  const touches = m.touches.filter((t) => t.at >= start && t.at <= now + MIN).sort((a, b) => a.at - b.at);
  const b = blockedSince(m);
  const blocked = m.displayStatus === "blocked" ? { at: b?.at ?? null, why: b?.why || m.headline } : null;
  const segs: Seg[] = touches.map((t, i) => {
    const prev = touches[i - 1];
    let from = prev ? Math.max(prev.at, t.at - MAX_SEG_MS) : t.at - FIRST_SEG_MS;
    if (t.at - from < MIN_SEG_MS) from = t.at - MIN_SEG_MS;
    return {
      kind: "edit", from: Math.max(from, start), to: t.at, label: base(t.path),
      title: `${t.path} · edited ${clock(t.at)}`, overlap: overlapPaths.some((p) => samePath(p, t.path)),
    };
  });
  const last = segs[segs.length - 1];
  const lastTouch = touches[touches.length - 1];
  let current: string | null = null;
  if (last && lastTouch && m.live && !blocked && now - lastTouch.at < NOW_MS) {
    last.kind = "now";
    last.to = now;
    last.label = `${lastTouch.path} · editing`;
    current = lastTouch.path;
  }
  if (blocked) {
    const from = Math.max(start, blocked.at ?? (lastTouch ? lastTouch.at : now - 10 * MIN));
    segs.push({ kind: "blocked", from, to: now, label: `blocked${blocked.why ? ` · ${blocked.why}` : ""}`, title: blocked.why || "blocked", overlap: false });
  }
  const dots: Dot[] = m.timeline
    .filter((t) => t.at >= start && t.at <= now + MIN && t.kind !== "blocked")
    .map((t) => {
      const kind: Dot["kind"] = t.kind === "merge" || (MERGED.test(t.summary) && !HEDGED.test(t.summary))
        ? "merge"
        : t.kind === "commit" || COMMIT.test(t.summary) ? "commit" : "update";
      return { kind, at: t.at, title: `${clock(t.at)} · ${t.summary}` };
    });
  return { segs, dots, away: !m.live, current, blocked };
}

export type Row = { m: Member; lane: Lane; you: boolean; overlap: boolean; href: string };

/** Lanes in reading order: you first, then live, blocked, and away (each by recency). */
export function rowsOf(proj: Project, now: number, me: string): Row[] {
  const live = proj.collisions;
  const pathsFor = (m: Member) =>
    live.filter((c) => !isBranchArea(c.area) && collisionIds(c, proj.members).includes(m.member)).map((c) => c.area);
  const inOverlap = new Set(live.flatMap((c) => collisionIds(c, proj.members)));
  const rank = (m: Member) => (m.member === me ? 0 : !m.live ? 3 : m.displayStatus === "blocked" ? 2 : 1);
  return [...proj.members]
    .sort((a, b) => rank(a) - rank(b) || b.lastSeen - a.lastSeen)
    .map((m) => ({
      m,
      lane: laneOf(m, now, pathsFor(m)),
      you: !!me && m.member === me,
      overlap: inOverlap.has(m.member),
      href: `/project/${encodeURIComponent(proj.id)}/${encodeURIComponent(m.member)}`,
    }));
}

const pct = (t: number, now: number) => Math.min(100, Math.max(0, ((t - (now - WINDOW_MS)) / WINDOW_MS) * 100));
const tone = (r: Row) => (r.lane.away ? "away" : r.lane.blocked ? "blocked" : r.overlap ? "overlap" : "live");
const subline = (m: Member) => m.git?.branch || (m.git ? "branch hidden" : m.live ? "connected" : "no git state yet");

function statusText(r: Row, now: number): string {
  const { m, lane } = r;
  if (lane.away) return `away ${span(m.lastSeen)}`;
  if (lane.blocked) return `blocked${lane.blocked.at ? ` ${span(lane.blocked.at)}` : ""}${lane.blocked.why ? `: ${lane.blocked.why}` : ""}`;
  if (lane.current) return `editing ${lane.current}`;
  return `live, last active ${span(Math.min(m.lastSeen, now))} ago`;
}

function Face({ r }: { r: Row }) {
  const t = tone(r);
  const editing = !!r.lane.current;
  return (
    <span className={`pj-face ${t}`} aria-hidden="true">
      {initials(r.m.displayName)}
      <span className={`pj-face-dot ${t}${editing ? " pulse" : ""}`} />
    </span>
  );
}

function Bar({ r, now, mini }: { r: Row; now: number; mini?: boolean }) {
  const { lane } = r;
  return (
    <span className={`pj-bar${mini ? " mini" : ""}${lane.away ? " away" : ""}`} aria-hidden="true">
      <span className="pj-bar-line" />
      {lane.segs.map((s, i) => {
        const left = pct(s.from, now);
        const width = Math.max(pct(s.to, now) - left, mini ? 1.5 : 2.5);
        return (
          <span
            key={i}
            className={`pj-seg ${s.kind}${s.overlap ? " ov" : ""}`}
            style={s.kind === "edit" ? { left: `${left}%`, width: `${width}%` } : { left: `${left}%`, right: 0 }}
            title={s.title}
          >
            {!mini && <span className="pj-seg-l">{s.label}</span>}
          </span>
        );
      })}
      {lane.dots.map((d, i) => (
        <span key={`d${i}`} className={`pj-dot ${d.kind}`} style={{ left: `${pct(d.at, now)}%` }} title={d.title} />
      ))}
      {lane.away && !mini && (
        <span className="pj-away" style={{ left: `${Math.min(62, Math.max(4, pct(r.m.lastSeen, now) + 2))}%` }}>
          away {span(r.m.lastSeen)}
          {r.m.handoffs.length > 0 ? ` · ${r.m.handoffs.length} waiting on return` : " · nothing waits on them"}
        </span>
      )}
    </span>
  );
}

function Ticks({ now }: { now: number }) {
  const start = now - WINDOW_MS;
  return (
    <div className="pj-ticks" aria-hidden="true">
      <span className="pj-ticks-gutter" />
      <span className="pj-ticks-track">
        {[0, 0.25, 0.5, 0.75].map((f) => (
          <span key={f} style={{ left: `${f * 100}%` }} className={f === 0 ? "first" : ""}>{clock(start + f * WINDOW_MS)}</span>
        ))}
        <span className="now" style={{ left: "100%" }}>now · {clock(now)}</span>
      </span>
    </div>
  );
}

/** The desktop lanes: one row per member across the last hour, overlaps drawn between rows. */
export function Lanes({ rows, collisions, members, now }: { rows: Row[]; collisions: Collision[]; members: Member[]; now: number }) {
  const index = new Map(rows.map((r, i) => [r.m.member, i]));
  const links = collisions.flatMap((c, k) => {
    const idx = collisionIds(c, members).map((id) => index.get(id)).filter((x): x is number => x !== undefined);
    if (idx.length < 2) return [];
    const caught = caughtAt(c, members);
    const at = caught ? caught.at : now;
    return [{
      key: k, lo: Math.min(...idx), hi: Math.max(...idx), x: Math.min(97, Math.max(3, pct(at, now))),
      label: `${caught?.sent ? "heads-up" : "overlap"} ${clock(at)}`,
    }];
  });
  return (
    <div className="pj-lanes">
      <div className="pj-lanes-in">
        <Ticks now={now} />
        <div className="pj-rows" style={{ ["--row-h" as string]: `${ROW_H}px` }}>
          <div className="pj-overlay" aria-hidden="true">
            <span className="pj-now" />
            {links.map((l) => (
              <span key={l.key} className="pj-link" style={{ left: `${l.x}%`, top: l.lo * ROW_H }}>
                <span className="pj-link-label">{l.label}</span>
                <span className="pj-link-line" style={{ top: 30, height: (l.hi - l.lo) * ROW_H + 24 }} />
                <span className="pj-link-glow" style={{ top: ((l.hi - l.lo) * ROW_H) / 2 + 20 }} />
              </span>
            ))}
          </div>
          {rows.map((r) => (
            <Link key={r.m.member} href={r.href} className={`pj-row${r.lane.away ? " away" : ""}`} aria-label={`${r.m.displayName}${r.you ? " (you)" : ""}: ${statusText(r, now)}. Open brief.`}>
              <span className="pj-who">
                <Face r={r} />
                <span className="pj-who-t">
                  <span className="pj-name">{r.m.displayName}{r.you && <span className="pj-you">you</span>}</span>
                  <span className="pj-sub">{subline(r.m)}</span>
                  {r.m.headline && <span className="pj-head" title={r.m.headline}>{r.m.headline}</span>}
                </span>
              </span>
              <Bar r={r} now={now} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The phone layout: people as list rows, each with a mini lane bar. */
export function PeopleList({ rows, now }: { rows: Row[]; now: number }) {
  return (
    <ul className="pj-people">
      {rows.map((r) => {
        const { lane, m } = r;
        const chip = lane.away
          ? <span className="pj-pchip away">away {span(m.lastSeen)}</span>
          : lane.blocked
            ? <span className="pj-pchip blocked">blocked{lane.blocked.at ? ` ${span(lane.blocked.at)}` : ""}</span>
            : lane.current
              ? <span className={`pj-pchip now${r.overlap ? " ov" : ""}`}>{base(lane.current)}</span>
              : null;
        return (
          <li key={m.member}>
            <Link href={r.href} aria-label={`${m.displayName}${r.you ? " (you)" : ""}: ${statusText(r, now)}. Open brief.`}>
              <span className="pj-prow">
                <Face r={r} />
                <span className="pj-who-t">
                  <span className="pj-name">{m.displayName}{r.you && <span className="pj-you">you</span>}</span>
                  <span className="pj-sub">{subline(m)}</span>
                </span>
                {chip}
              </span>
              <Bar r={r} now={now} mini />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Legend() {
  return (
    <ul className="pj-legend" aria-label="Legend">
      <li><span className="sw now" aria-hidden="true" />Editing now</li>
      <li><span className="sw edit" aria-hidden="true" />Earlier edit</li>
      <li><span className="sw commit" aria-hidden="true" />Commit</li>
      <li><span className="sw merge" aria-hidden="true" />Merge</li>
      <li><span className="sw update" aria-hidden="true" />Agent update</li>
      <li><span className="sw ov" aria-hidden="true" />Overlap caught</li>
      <li><span className="sw blocked" aria-hidden="true" />Blocked</li>
      <li><span className="sw away" aria-hidden="true" />Away</li>
    </ul>
  );
}

/** Files the most teammates touched in the window; ones two agents share are pink. */
export function HotFiles({ members, collisions, now }: { members: Member[]; collisions: Collision[]; now: number }) {
  const by = new Map<string, { path: string; who: Set<string>; at: number }>();
  for (const m of members) {
    for (const t of m.touches) {
      if (t.at < now - WINDOW_MS) continue;
      const key = t.path.toLowerCase();
      const e = by.get(key) ?? by.set(key, { path: t.path, who: new Set(), at: 0 }).get(key)!;
      e.who.add(m.displayName);
      e.at = Math.max(e.at, t.at);
    }
  }
  const shared = collisions.filter((c) => !isBranchArea(c.area)).map((c) => c.area);
  const hot = [...by.values()].sort((a, b) => b.who.size - a.who.size || b.at - a.at).slice(0, 8);
  return (
    <div className="pj-hot">
      <h2 className="pj-hot-h">Hot files</h2>
      {hot.length === 0 ? (
        <span className="pj-quiet">No edits in the last hour.</span>
      ) : (
        <ul>
          {hot.map((f) => {
            const ov = f.who.size > 1 || shared.some((p) => samePath(p, f.path));
            return (
              <li key={f.path} className={`rz-chip file${ov ? " overlap" : ""}`} title={`${[...f.who].join(", ")} · last edit ${clock(f.at)}`}>
                {f.path}
                {f.who.size > 1 && <span className="pj-hot-n">· {f.who.size} agents</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
