"use client";
import { use, useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, type ItemKind, type TodayData } from "@/lib/api";
import { Invite } from "@/components/invite";
import { PageState, PhoneTabs, StaleNote, WorkHeader, isLead, useAction, useNow, useViewer, useWork } from "@/components/work/shell";
import { AgentTile, Avatar, SectionHead } from "@/components/work/bits";
import { LaneCompact, LaneRow, itemHref } from "@/components/work/lane";
import { Legend, Tracks } from "@/components/work/tracks";
import { NeedsPanel } from "@/components/work/needs";
import { HandoverDialog, NewItemDialog, ReleaseDialog, WriteDialog } from "@/components/work/dialogs";
import { KINDS, KIND_LABEL, agentName, clock, countWord, dayLine, kindPhrase, ownsPhrase, plural, shortDate, voice } from "@/components/work/format";

const GROUP_TITLE: Record<TodayData["groups"][number]["kind"], string> = {
  feature: "Features",
  bug: "Bugs",
  try_chore: "Trying out & chores",
};

export default function TodayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const fetcher = useCallback(() => api.today(id), [id]);
  const { data, missing, err, load, live } = useWork(id, id, fetcher);
  const now = useNow();
  const me = useViewer();
  const [newItem, setNewItem] = useState(false);
  const [release, setRelease] = useState(false);
  const [write, setWrite] = useState(false);
  const [handover, setHandover] = useState<{ id: string; title: string } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const name = data?.project.name || id;
  useEffect(() => { document.title = `Today · ${name} · Reins`; }, [name]);

  if (!data) {
    return (
      <div className="w-page">
        <div className="w-wash"><WorkHeader projectId={id} projectName={name} view="today" /></div>
        <PageState projectId={id} missing={missing} err={err} retry={load} />
        <PhoneTabs projectId={id} current="today" />
      </div>
    );
  }

  const t = data;
  const at = now || t.now;
  const lead = isLead(me, t.viewer.role);
  const viewerId = t.viewer.member;
  const total = t.counts.feature + t.counts.bug + t.counts.try + t.counts.chore;
  const moving = total === 0 ? "Nothing is moving yet." : `${plural(total, "thing")} moving`;
  const liveRows = t.tracks.rows.filter((r) => r.clips.some((c) => c.to == null));
  const livePeople = new Set(liveRows.map((r) => r.who.member)).size;
  const sinceParts = [
    t.since.tasksDone ? plural(t.since.tasksDone, "task") + " done" : "",
    t.since.questionsSettled ? `${plural(t.since.questionsSettled, "question")} settled between agents` : "",
    t.since.blocked ? `${t.since.blocked} blocked` : "",
  ].filter(Boolean);
  const anyItems = t.groups.some((g) => g.items.length > 0);
  const needCount = t.needs.length;
  // The same count as the "needs you" pill and panel, so the headline never contradicts them.
  const waitLine = needCount > 0 ? `${countWord(needCount)} ${needCount === 1 ? "thing needs" : "things need"} you.` : "Nothing needs you.";
  const allLanes = t.groups.flatMap((g) => g.items);
  const quiet = !anyItems && t.untracked.length === 0 && t.tracks.rows.length === 0;

  return (
    <div className="w-page">
      <div className="w-wash">
        <WorkHeader projectId={id} projectName={name} view="today">
          <span className="w-liveline w-desk-flex" role="status">
            <span aria-hidden="true" className={`w-livedot${live ? "" : " off"}`} />
            {!live ? "Offline" : liveRows.length === 0 ? "Live · no agents working" : `Live · ${plural(liveRows.length, "agent")} · ${plural(livePeople, "person", "people")}`}
          </span>
          {needCount > 0 && <a href="#needs" className="w-pill pink w-desk-flex">{needCount} need{needCount === 1 ? "s" : ""} you</a>}
        </WorkHeader>

        <div className="w-hero">
          <span className="w-eyebrow">{dayLine(at)}</span>
          <h1>
            <span className="w-desk-inline">{total === 0 ? moving : `${moving}: ${kindPhrase(t.counts)}.`} {waitLine}</span>
            <span className="w-phone-inline">{total === 0 ? moving : `${moving}.`} {waitLine}</span>
          </h1>
          <p>
            <span className="w-phone-inline">{total > 0 ? `${kindPhrase(t.counts).replace(/^./, (c) => c.toUpperCase())}. ` : ""}{liveRows.length ? `${plural(liveRows.length, "agent")} live.` : ""}</span>
            <span className="w-desk-inline">{sinceParts.length ? `Today so far: ${sinceParts.join(", ")}.` : "Quiet so far today."}</span>
          </p>
          <div className="w-hero-acts">
            <button type="button" className="w-btn small" onClick={() => setNewItem(true)}>New item</button>
            <button type="button" className="w-btn small" onClick={() => { setSentTo(null); setWrite(true); }}>Write to the team</button>
            {lead && !t.release && <button type="button" className="w-btn small ghost" onClick={() => setRelease(true)}>Plan a release</button>}
          </div>
          {sentTo && <p className="w-ok" role="status">Note sent to {sentTo}. Their agents read it at the next prompt.</p>}
        </div>

        {t.release && (
          <section aria-label="Release" className="w-release">
            <span className="w-release-name">
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>
              Release {t.release.title}{t.release.dueAt ? ` · ${shortDate(t.release.dueAt)}` : ""}
            </span>
            <span className="w-release-items w-desk-inline">
              {t.release.items.length === 0 ? "No items in it yet." : t.release.items.map((it, i) => (
                <span key={it.id}>
                  {i > 0 && " · "}
                  <Link href={itemHref(id, it.id)} className="w-ink-link">{it.title}</Link>{" "}
                  <b className={`tone-${it.tone}`}>{it.stateText}</b>
                </span>
              ))}
            </span>
            <span className="w-release-items w-phone-inline">{releaseSummary(t.release.items)}</span>
            {lead && <button type="button" className="w-link w-push" onClick={() => setRelease(true)}>Edit</button>}
          </section>
        )}

        <section aria-labelledby="own-h" className="w-owned w-desk">
          <h2 id="own-h" className="w-sr">Who owns what</h2>
          {!anyItems && t.untracked.length === 0 ? (
            <div className="w-owned-empty">
              <p className="w-strong">Nothing is tracked yet.</p>
              <p className="w-quiet">Create an item someone owns, or connect an agent: its work shows up here as soon as it starts.</p>
              <div className="w-hero-acts">
                <button type="button" className="w-btn strong small" onClick={() => setNewItem(true)}>New item</button>
                <Link href={`/project/${encodeURIComponent(id)}/connect`} className="w-btn small">Connect an agent</Link>
              </div>
            </div>
          ) : (
            <>
              {t.groups.filter((g) => g.items.length > 0).map((g) => (
                <div key={g.kind} className="w-group">
                  <div className="w-group-h">
                    <h3>{GROUP_TITLE[g.kind]}</h3>
                    <span className="w-meta">{g.items.length}</span>
                  </div>
                  {g.items.map((l) => <LaneRow key={l.id} projectId={id} lane={l} />)}
                </div>
              ))}
              {t.untracked.map((u) => <Untracked key={u.sessionId} u={u} onDone={load} />)}
            </>
          )}
        </section>
      </div>

      <main className="w-body">
        <StaleNote err={err} retry={load} />

        {/* Phone: needs first, then a compact owned list and the agents right now. */}
        <section aria-labelledby="needs-ph" className="w-phone w-stack">
          <SectionHead id="needs-ph" title="Needs you">{needCount > 0 && <span className="w-count pink">{needCount}</span>}</SectionHead>
          <NeedsPanel projectId={id} needs={t.needs} overlaps={t.tracks.overlaps} now={at} onDone={load} onHandover={setHandover} compact />
        </section>
        <section aria-labelledby="own-ph" className="w-phone w-stack">
          <SectionHead id="own-ph" title="Who owns what" />
          {allLanes.length === 0 && t.untracked.length === 0 ? (
            <div className="w-card w-calm-empty">
              <p>Nothing is tracked yet.</p>
              <div className="w-hero-acts">
                <button type="button" className="w-btn strong" onClick={() => setNewItem(true)}>New item</button>
                <Link href={`/project/${encodeURIComponent(id)}/connect`} className="w-btn">Connect an agent</Link>
              </div>
            </div>
          ) : (
            <div className="w-card w-list">
              {allLanes.map((l) => <LaneCompact key={l.id} projectId={id} lane={l} />)}
              {t.untracked.map((u) => <Untracked key={u.sessionId} u={u} onDone={load} compact />)}
            </div>
          )}
        </section>
        <section aria-labelledby="ag-ph" className="w-phone w-stack">
          <SectionHead id="ag-ph" title="Agents right now" />
          {liveRows.length === 0 ? (
            <p className="w-card w-calm-empty">No agent is working right now.</p>
          ) : (
            <div className="w-card w-list">
              {liveRows.map((r) => {
                const c = r.clips.find((x) => x.to == null)!;
                const state = c.kind === "wait" ? "waiting" : c.kind === "block" ? "blocked" : "working";
                return (
                  <div key={r.sessionId} className="w-agentrow">
                    <AgentTile source={r.source} />
                    <span className="w-agentrow-t">
                      <span>{voice(r.who, r.source)} · {c.label}</span>
                      <span className="w-mono w-meta w-ellipsis">{r.branch || "no branch"}</span>
                    </span>
                    <span className={`w-dot w-dot-${state}`} aria-label={state} role="img" />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Desktop and tablet: the day by agent, with Needs you beside it. */}
        <div className="w-row w-desk">
          <section aria-labelledby="tr-h" className="w-col-main w-stack">
            <SectionHead id="tr-h" title="Today, by agent" note="each block is a task, tinted by the kind of work" />
            {t.tracks.rows.length === 0 ? (
              <div className="w-card w-calm-empty">
                <p>No agent has worked here today yet.</p>
                <p className="w-quiet">When a teammate’s agent starts, its day draws here: one row per agent, one block per task.</p>
                <Link href={`/project/${encodeURIComponent(id)}/connect`} className="w-btn small">Connect an agent</Link>
              </div>
            ) : (
              <>
                <Tracks projectId={id} tracks={t.tracks} needs={t.needs} now={at} />
                <Legend />
              </>
            )}
          </section>
          <aside id="needs" aria-labelledby="needs-h" className="w-col-side w-stack">
            <SectionHead id="needs-h" title="Needs you">
              {needCount > 0 && <span className="w-count pink">{needCount}</span>}
              {needCount > 1 && <span className="w-meta w-push">oldest first</span>}
            </SectionHead>
            <NeedsPanel projectId={id} needs={t.needs} overlaps={t.tracks.overlaps} now={at} onDone={load} onHandover={setHandover} />
          </aside>
        </div>

        <div className="w-row">
          <section aria-labelledby="tp-h" className="w-col-main w-stack w-desk">
            <SectionHead id="tp-h" title="The tape" note="handovers, questions, decisions, finishes, findings" />
            {t.tape.length === 0 ? (
              <p className="w-quiet">Nothing on the tape yet today.</p>
            ) : (
              <ol className="w-tape">
                {t.tape.map((e, i) => (
                  <li key={i} className={`tape-${e.kind.replace(/\s+/g, "").toLowerCase()}`}>
                    <span aria-hidden="true" className="w-tape-dot" />
                    <time className="w-mono w-meta" dateTime={new Date(e.at).toISOString()}>{clock(e.at)}</time>
                    <span className="w-tape-k">{e.kind}</span>
                    <span className="w-tape-t">{e.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section id="people" aria-labelledby="pp-h" className="w-col-side w-stack w-people">
            <SectionHead id="pp-h" title="People this week" note="counted, not scored" />
            {t.people.length === 0 ? (
              <div className="w-card w-calm-empty">
                <p>Nobody has connected an agent yet.</p>
                <p className="w-quiet">Each person runs one command; their agents start showing up here.</p>
              </div>
            ) : (
              <div className="w-card w-list">
                {t.people.map((p) => (
                  <Link key={p.who.member} href={`/project/${encodeURIComponent(id)}/people/${encodeURIComponent(p.who.member)}`} className="w-person">
                    <Avatar who={p.who} size={34} />
                    <span className="w-person-t">
                      <span className="w-strong">{p.who.displayName}{p.who.member === viewerId ? " (you)" : ""} <span className="w-meta">· {ownsPhrase(p.owns)}</span></span>
                      {p.style && <span className="w-small w-ink2">{p.style}</span>}
                    </span>
                    <span className="w-person-n"><span>{p.done7d}</span><span className="w-meta">done</span></span>
                  </Link>
                ))}
              </div>
            )}
            <div className="w-foot-acts">
              <Link href={`/project/${encodeURIComponent(id)}/connect`} className="w-link">Connect an agent</Link>
              <Invite projectId={id} />
            </div>
          </section>
        </div>
        {quiet && <p className="w-quiet w-center">This page updates live as agents work. Nothing here is made up.</p>}
      </main>

      <NewItemDialog projectId={id} open={newItem} onClose={() => setNewItem(false)} onDone={load} me={viewerId} release={t.release ? { id: t.release.id, title: t.release.title } : null} />
      <ReleaseDialog projectId={id} open={release} onClose={() => setRelease(false)} onDone={load} release={t.release ? { id: t.release.id, title: t.release.title, dueAt: t.release.dueAt } : null} />
      <WriteDialog projectId={id} open={write} onClose={() => setWrite(false)} onDone={load} onSent={setSentTo} me={viewerId} />
      <HandoverDialog projectId={id} open={!!handover} onClose={() => setHandover(null)} onDone={load} item={handover} />
      <PhoneTabs projectId={id} current="today" />
    </div>
  );
}

function releaseSummary(items: { tone: string }[]): string {
  if (items.length === 0) return "no items yet";
  const ok = items.filter((i) => i.tone === "good" || i.tone === "calm").length;
  const wait = items.filter((i) => i.tone === "needs").length;
  const risk = items.filter((i) => i.tone === "block").length;
  return [ok ? `${ok} on track` : "", wait ? `${wait} waiting` : "", risk ? `${risk} at risk` : ""].filter(Boolean).join(", ");
}

/** Agent work not on any item yet, with "Track it" to turn it into an owned item. */
function Untracked({ u, onDone, compact }: { u: TodayData["untracked"][number]; onDone: () => void; compact?: boolean }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ItemKind>("chore");
  const { busy, err, run } = useAction(onDone);
  const who = `${u.member.displayName}’s ${agentName(u.source) || "agent"}`;

  const track = async () => {
    if (await run(() => api.trackSession(u.sessionId, { kind, ...(title.trim() ? { title: title.trim() } : {}) }))) setOpen(false);
  };

  return (
    <div className={compact ? "w-untracked compact" : "w-untracked"}>
      <div className="w-lane-who">
        {compact ? <AgentTile source={u.source} /> : null}
        <span className="w-lane-name">
          <span className="w-small w-strong w-ink2">{compact ? who : "Untracked"}</span>
          <span className="w-meta">{compact ? `untracked · ${u.minutes} min` : "agent work not on any item yet"}</span>
        </span>
      </div>
      <span className="w-untracked-t">
        {!compact && <><b className="w-strong">{who}</b> · {u.minutes} min. </>}{u.text}
      </span>
      {!open ? (
        <button type="button" className="w-btn sky small" onClick={() => setOpen(true)} aria-label={`Track ${who}’s work as an item`}>Track it</button>
      ) : (
        <form className="w-track-form" onSubmit={(e) => { e.preventDefault(); track(); }}>
          <label htmlFor={`${uid}-t`} className="w-sr">Name it</label>
          <input id={`${uid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name it (optional)" maxLength={200} autoFocus />
          <label htmlFor={`${uid}-k`} className="w-sr">Kind</label>
          <select id={`${uid}-k`} value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <button type="submit" className="w-btn strong small" disabled={busy}>Track</button>
          <button type="button" className="w-btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
          {err && <p className="w-err" role="alert">{err}</p>}
        </form>
      )}
    </div>
  );
}
