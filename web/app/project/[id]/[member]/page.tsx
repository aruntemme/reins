"use client";
import { Fragment, useCallback, useEffect, useRef, useState, use } from "react";
import Link from "next/link";
import { ProjectTabs } from "@/components/project-tabs";
import {
  api, ApiError, errorMessage, timeAgo,
  type Me, type MemberBrief, type MemberDetail, type Project, type TraitType,
} from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { Mark, initials } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import "./member.css";

const TRAIT_LABEL: Record<TraitType, string> = {
  tooling: "Tools & tech",
  quality: "Quality bar",
  communication: "Communication",
  concern: "Cares about",
  workflow: "Workflow",
};

const HKIND: Record<string, string> = { mention: "@mention", collision: "overlap", blocker: "blocker", fyi: "fyi", assignment: "assignment" };

type Act = (p: Promise<unknown>) => Promise<void>;

export default function MemberPage({ params }: { params: Promise<{ id: string; member: string }> }) {
  const { id, member } = use(params);
  const memberId = decodeURIComponent(member);
  const [m, setM] = useState<MemberDetail | null>(null);
  const [proj, setProj] = useState<Project | null>(null);
  const [brief, setBrief] = useState<MemberBrief | null>(null);
  const [briefErr, setBriefErr] = useState("");
  const [missing, setMissing] = useState(false);
  // A failed load that is not a 404: transient, cleared on the next good load.
  const [loadErr, setLoadErr] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  // The last failed action, with the server's message.
  const [actErr, setActErr] = useState("");
  const [busy, setBusy] = useState(false);

  // The member is required; the project (for teammates) and the brief degrade on their own.
  const load = useCallback(async () => {
    const [md, pj, br] = await Promise.allSettled([api.member(id, memberId), api.project(id), api.memberBrief(id, memberId)]);
    if (md.status === "rejected") {
      if (handleAuth(md.reason)) return;
      if (md.reason instanceof ApiError && md.reason.status === 404) setMissing(true);
      else setLoadErr(errorMessage(md.reason));
      return;
    }
    setM(md.value);
    setMissing(false);
    setLoadErr("");
    if (pj.status === "fulfilled") setProj(pj.value);
    if (br.status === "fulfilled") { setBrief(br.value); setBriefErr(""); }
    else if (!handleAuth(br.reason)) setBriefErr(errorMessage(br.reason));
  }, [id, memberId]);

  const act = useCallback<Act>(async (p) => {
    setActErr("");
    setBusy(true);
    try {
      await p;
      await load();
    } catch (e) {
      if (!handleAuth(e)) setActErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.me().then(setMe).catch(() => {}); }, []);
  const live = useStream(id, load);
  const isMe = !!me?.member && me.member === memberId;
  const shell = { id, name: m?.displayName ?? memberId, workspace: me?.workspace?.name, live };

  if (missing)
    return (
      <Shell {...shell}>
        <main className="mb-solo">
          <div className="rz-card mb-card mb-empty-card">
            <h1 className="mb-h2">No one called “{memberId}” in {id}</h1>
            <p className="mb-note">They show up here once their agent sends its first update.</p>
            <Link href={`/project/${encodeURIComponent(id)}`} className="rz-btn ghost mb-sm">Back to lanes</Link>
          </div>
        </main>
      </Shell>
    );
  if (!m)
    return (
      <Shell {...shell}>
        <main className="mb-solo">
          {loadErr ? (
            <div className="rz-card mb-card mb-empty-card" role="alert">
              <p className="mb-note">Could not load this page: {loadErr}</p>
              <button type="button" className="rz-btn ghost mb-sm" onClick={load}>Retry</button>
            </div>
          ) : <p className="mb-note" aria-live="polite">Loading…</p>}
        </main>
      </Shell>
    );

  const name = m.displayName;
  const tone = !m.live ? "away" : m.displayStatus === "blocked" ? "blocked" : "live";
  const lastTouch = m.touches[0]?.path;
  const statusText =
    tone === "away" ? `Away · last seen ${timeAgo(m.lastSeen)}`
    : tone === "blocked" ? `Blocked · last signal ${timeAgo(m.lastSeen)}`
    : lastTouch ? `Live · editing ${lastTouch.split("/").pop()}`
    : `Live · last signal ${timeAgo(m.lastSeen)}`;
  const gitLine = [m.git?.branch && `⎇ ${m.git.branch}`, m.git?.dirty ? `${m.git.dirty} uncommitted` : ""].filter(Boolean).join(" · ");
  const possessive = isMe ? "your" : `${name}’s`;

  return (
    <Shell {...shell}>
      <div className="mb-wrap">
        <section className="rz-field mb-profile" aria-label={`About ${name}`}>
          <span className="rz-blob mb-blob" aria-hidden="true" />
          <Link href={`/project/${encodeURIComponent(id)}`} className="mb-hero-back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            {id}
          </Link>
          <div className="mb-pro-row">
            <span className="mb-av" aria-hidden="true">
              {initials(name)}
              <span className={`rz-live${tone === "live" ? "" : ` ${tone}`}`} />
            </span>
            <div className="mb-pro-id">
              <p className="mb-name">{name}{isMe && <span className="mb-you"> (you)</span>}</p>
              {gitLine && <span className="mb-meta">{gitLine}</span>}
            </div>
          </div>
          <span className={`mb-pill ${tone}`}>{statusText}</span>
        </section>

        <main className="mb-main">
          <div className="mb-head">
            <div className="mb-head-t">
              <h1 className="mb-h1">What {possessive} agent is told</h1>
              <span className="mb-sub">
                <span className={`mb-tick${live ? "" : " off"}`} aria-hidden="true" />
                {live ? "Rebuilt on every board change: what a session starting now would get." : "Showing the last snapshot while the live connection comes back."}
              </span>
            </div>
          </div>

          {(loadErr || actErr) && (
            <div className="mb-alert" role="alert">{actErr || `Could not refresh: ${loadErr}`}</div>
          )}

          <BriefTabs
            human={<ForYouCards m={m} proj={proj} isMe={isMe} />}
            agent={<AgentView brief={brief} err={briefErr} retry={load} />}
          />

          {m.handoffs.length > 0 && (
            <section className="rz-card mb-card" aria-labelledby="mb-ho-h">
              <h2 className="mb-h2" id="mb-ho-h">Handoffs for {isMe ? "you" : name}</h2>
              <p className="mb-note">Open ones reach {possessive} agent at session start.</p>
              <Handoffs items={m.handoffs} projectId={id} member={memberId} act={act} busy={busy} />
            </section>
          )}

          {m.pending.length > 0 && (
            <section className="rz-card mb-card" aria-labelledby="mb-pe-h">
              <h2 className="mb-h2" id="mb-pe-h">Pending from {isMe ? "you" : name}</h2>
              <ul className="mb-rows">
                {m.pending.map((p) => (
                  <li key={p.id} className="mb-row">
                    <span className="mb-row-main">{p.text}</span>
                    <span className="mb-row-side">{p.status === "claimed" ? `claimed by ${p.claimedBy}` : "open"}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rz-card mb-card" aria-labelledby="mb-tl-h">
            <h2 className="mb-h2" id="mb-tl-h">Recent activity</h2>
            {m.timeline.length === 0
              ? <p className="mb-note">No activity yet. It appears as {possessive} agent works.</p>
              : <Activity items={m.timeline} />}
          </section>

          {m.resolvedHandoffs.length > 0 && (
            <section className="rz-card mb-card" aria-labelledby="mb-hh-h">
              <h2 className="mb-h2" id="mb-hh-h">Handoff history</h2>
              <HandoffHistory items={m.resolvedHandoffs} projectId={id} act={act} busy={busy} />
            </section>
          )}
        </main>

        <aside className="mb-side" aria-label={`${name}’s profile`}>
          <Traits m={m} isMe={isMe} act={act} busy={busy} />
          <Glance m={m} />
        </aside>
      </div>
      <ProjectTabs
        projectId={id}
        me={me?.member && proj?.members.some((x) => x.member === me.member) ? me.member : null}
        current={isMe ? "brief" : undefined}
        lead={!!me && (me.admin || !me.auth)}
      />
    </Shell>
  );
}

function Shell({ id, name, workspace, live, children }: { id: string; name: string; workspace?: string; live: boolean; children: React.ReactNode }) {
  const lanes = `/project/${encodeURIComponent(id)}`;
  return (
    <div className="mb-page">
      <header className="mb-bar">
        <div className="mb-bar-l">
          <Link href="/dashboard" className="mb-home" aria-label="Reins home"><Mark size={36} /></Link>
          <nav aria-label="Breadcrumb" className="mb-crumbs">
            <ol>
              {workspace && <li><Link href="/dashboard">{workspace}</Link></li>}
              <li><Link href={lanes}>{id}</Link></li>
              <li aria-current="page">{name}</li>
            </ol>
          </nav>
        </div>
        <div className="mb-bar-r">
          <span className="mb-conn"><span className={`rz-live${live ? "" : " away"}`} aria-hidden="true" />{live ? "live" : "offline"}</span>
          <Link href={lanes} className="rz-btn ghost mb-back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
            Back to lanes
          </Link>
          <UserMenu />
        </div>
      </header>
      {children}
    </div>
  );
}

function BriefTabs({ human, agent }: { human: React.ReactNode; agent: React.ReactNode }) {
  const [view, setView] = useState<"human" | "agent">("human");
  const refs = { human: useRef<HTMLButtonElement>(null), agent: useRef<HTMLButtonElement>(null) };
  const onKey = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === "Home" ? "human" : e.key === "End" ? "agent" : view === "human" ? "agent" : "human";
    setView(next);
    refs[next].current?.focus();
  };
  const tab = (v: "human" | "agent", label: React.ReactNode) => (
    <button
      ref={refs[v]}
      type="button"
      role="tab"
      id={`mb-tab-${v}`}
      aria-selected={view === v}
      aria-controls="mb-brief-panel"
      tabIndex={view === v ? 0 : -1}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  );
  return (
    <>
      <div role="tablist" aria-label="Brief view" className="mb-tabs" onKeyDown={onKey}>
        {tab("human", "For you")}
        {tab("agent", <><span className="mb-wide">Exactly what the agent sees</span><span className="mb-narrow">What the agent sees</span></>)}
      </div>
      <div role="tabpanel" id="mb-brief-panel" aria-labelledby={`mb-tab-${view}`} key={view}>
        {view === "human" ? human : agent}
      </div>
    </>
  );
}

// Readable cards built from the same state the hook packs: focus, files others
// hold, teammates live now, the lead's word, and work up for grabs.
function ForYouCards({ m, proj, isMe }: { m: MemberDetail; proj: Project | null; isMe: boolean }) {
  const name = m.displayName;
  const others = (proj?.members ?? []).filter((x) => x.member !== m.member);
  const nameOf = (mid: string) => proj?.members.find((x) => x.member === mid)?.displayName || mid;
  const isMine = (who: string) => who === m.displayName || who === m.member;

  const asks: { what: string; who: string; why: "overlap" | "assigned" | "edited" }[] = [];
  const seen = new Set<string>();
  for (const c of proj?.collisions ?? []) {
    if (!c.members.some(isMine) || seen.has(c.area)) continue;
    asks.push({ what: c.area, who: c.members.filter((w) => !isMine(w)).join(", "), why: "overlap" });
    seen.add(c.area);
  }
  for (const a of proj?.assignments ?? []) {
    if (a.member === m.member || seen.has(a.area)) continue;
    asks.push({ what: a.area, who: nameOf(a.member), why: "assigned" });
    seen.add(a.area);
  }
  for (const o of others.filter((x) => x.live)) {
    for (const t of o.touches) {
      if (seen.has(t.path)) continue;
      asks.push({ what: t.path, who: o.displayName, why: "edited" });
      seen.add(t.path);
    }
  }
  const nearby = others.filter((x) => x.live).slice(0, 4);
  const grabs = (proj?.pending ?? []).filter((p) => p.status === "open" && p.member !== m.member).slice(0, 4);
  const lead = m.directives.length + m.assignments.length > 0;
  const files = [...m.touches.map((t) => t.path), ...m.workingOn.filter((w) => !m.touches.some((t) => t.path === w))];

  return (
    <div className="mb-cards">
      <section className="rz-card mb-fy">
        <h2>Focus</h2>
        <p className="mb-focus">{m.headline || `No headline yet. It fills in from ${isMe ? "your" : `${name}’s`} next prompts.`}</p>
        {m.goal && <p className="mb-fy-line"><span className="mb-k">Goal</span> {m.goal}</p>}
        {proj?.goal && <p className="mb-fy-line"><span className="mb-k">Project goal</span> {proj.goal}</p>}
        {files.length > 0 && (
          <ul className="mb-chips" aria-label="Working on">
            {files.slice(0, 6).map((f) => <li key={f} className="rz-chip file">{f}</li>)}
          </ul>
        )}
        <span className="mb-note">from {isMe ? "your" : "their"} latest activity, edits and goals</span>
      </section>

      {asks.length > 0 && (
        <section className="rz-card mb-fy ask">
          <h2>Taken by others · ask first</h2>
          <ul className="mb-asks">
            {asks.slice(0, 6).map((a) => (
              <li key={a.what}>
                <span className="mb-path">{a.what}</span>
                <span className="mb-who">
                  {a.why === "overlap" ? <span className="rz-chip overlap">overlap with {a.who}</span>
                    : a.why === "assigned" ? `${a.who} · assigned by the lead` : a.who}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {proj && <section className="rz-card mb-fy">
        <h2>Teammates nearby</h2>
        {nearby.length === 0 ? (
          <p className="mb-note">No teammates are live right now.</p>
        ) : nearby.map((t) => (
          <p key={t.member} className="mb-mate">
            <Link href={`/project/${encodeURIComponent(m.projectId)}/${encodeURIComponent(t.member)}`} className="mb-mate-n">{t.displayName}</Link>
            {t.displayStatus === "blocked" && <span className="rz-chip blocked">blocked</span>}
            {" "}{t.headline || "no headline yet"}
          </p>
        ))}
      </section>}

      {lead && (
        <section className="rz-card mb-fy">
          <h2>From the lead</h2>
          {m.directives.map((d) => (
            <div key={d.id} className="mb-lead">
              <p className="mb-quote">“{d.text}”</p>
              <span className="mb-note">
                {d.targets.length ? (isMe ? "to you" : `to ${name}`) : "to the whole team"}
                {d.by ? ` · from ${d.by}` : ""} · until {new Date(d.expiresAt).toLocaleString()}
              </span>
            </div>
          ))}
          {m.assignments.map((a) => (
            <div key={a.id} className="mb-lead">
              <p className="mb-quote"><span className="mb-k">Assigned</span> <span className="mb-path">{a.area}</span>{a.note ? ` · ${a.note}` : ""}</p>
              <span className="mb-note">{a.by ? `by ${a.by} · ` : ""}{timeAgo(a.createdAt)}</span>
            </div>
          ))}
        </section>
      )}

      {grabs.length > 0 && (
        <section className="rz-card mb-fy">
          <h2>Up for grabs</h2>
          <ul className="mb-rows">
            {grabs.map((p) => (
              <li key={p.id} className="mb-row">
                <span className="mb-row-main">{p.text}</span>
                <span className="mb-row-side">from {nameOf(p.member)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const LABEL_RE = /^(- )((?:Lead directive[^:]*|Assigned to you[^:]*|Project goal|Your goals|Team goals|Collision[^:]*|Blocker[^:]*|@mention[^:]*|FYI[^:]*|Related to this prompt|Up for grabs and related):)(.*)$/;
const CONV_RE = /^(- )(Your working conventions)(.*)$/;
const OVERLAP_RE = /^(- .* also on )(.+)( — coordinate before you both change it\.)$/;
const FILES_RE = /^(- .+? \[[^\]]+\] — .*? · on )(.+?)((?: · branch .*)?)$/;

// Colours a few known prefixes; every character of the text is kept as sent.
function BriefLine({ line }: { line: string }) {
  let r = LABEL_RE.exec(line) || CONV_RE.exec(line);
  if (r) return <>{r[1]}<span className="mb-hl">{r[2]}</span>{r[3]}</>;
  // Pink only for a file two agents are both on; a teammate's other work stays neutral.
  r = OVERLAP_RE.exec(line);
  if (r) return <>{r[1]}<span className="mb-hl pink">{r[2]}</span>{r[3]}</>;
  r = FILES_RE.exec(line);
  if (r) return <>{r[1]}<span className="mb-hl plain">{r[2]}</span>{r[3]}</>;
  return <>{line}</>;
}

function AgentView({ brief, err, retry }: { brief: MemberBrief | null; err: string; retry: () => void }) {
  const [head, ...lines] = brief?.text ? brief.text.split("\n") : [];
  return (
    <div className="mb-term">
      <div className="mb-term-h">
        <span>SessionStart · additionalContext</span>
        <span><span className="mb-wide">capped at about 300 tokens</span><span className="mb-narrow">~300 token cap</span></span>
      </div>
      {!brief ? (
        err ? (
          <div className="mb-term-msg" role="alert">
            Could not load the brief: {err}{" "}
            <button type="button" className="mb-term-btn" onClick={retry}>Retry</button>
          </div>
        ) : <div className="mb-term-msg" aria-live="polite">Loading…</div>
      ) : brief.text ? (
        <>
          <pre className="mb-pre">
            <span className="mb-dim">{head}</span>
            {lines.map((l, i) => <Fragment key={i}>{"\n"}<BriefLine line={l} /></Fragment>)}
          </pre>
          <div className="mb-term-f">about {Math.ceil(brief.text.length / 4)} tokens right now{err ? ` · last refresh failed: ${err}` : ""}</div>
        </>
      ) : (
        <div className="mb-term-msg">
          Nothing to inject yet. With no goal, teammates or lead notes on this board, the hook stays silent at session start.
        </div>
      )}
    </div>
  );
}

function Traits({ m, isMe, act, busy }: { m: MemberDetail; isMe: boolean; act: Act; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const name = m.displayName;
  const traits = m.profile;
  const editable = isMe && traits.length > 0;

  const explain = m.sharesTraits
    ? `${isMe ? "Your" : `${name}’s`} agent gets the stronger ones as working conventions at session start, and handoffs routed to ${isMe ? "you" : "them"} carry the relevant ones.`
    : isMe
      ? "Private to the board. Turn sharing on to hand these to your agent at session start."
      : "Visible to the team here; not sent to any agent.";

  return (
    <section className="rz-card mb-card" aria-labelledby="mb-tr-h">
      <div className="mb-card-top">
        <h2 className="mb-h2" id="mb-tr-h">How {isMe ? "you work" : `${name} works`}</h2>
        {isMe ? (
          <label className="mb-share">
            <input
              type="checkbox"
              role="switch"
              checked={m.sharesTraits}
              disabled={busy}
              onChange={(e) => act(api.setTraitsSharing(e.target.checked))}
            />
            Share with agents
          </label>
        ) : (
          <span className={`mb-share-state${m.sharesTraits ? " on" : ""}`}>{m.sharesTraits ? "Shared with agents" : "Not shared"}</span>
        )}
      </div>

      {traits.length === 0 ? (
        <p className="mb-note">No profile yet. It builds up from how {isMe ? "you" : "they"} work.</p>
      ) : editing ? (
        <ul className="mb-trait-edit">
          {traits.map((t) => {
            const draft = drafts[t.id] ?? t.statement;
            const changed = draft.trim() !== t.statement && draft.trim() !== "";
            return (
              <li key={t.id}>
                <form
                  onSubmit={(e) => { e.preventDefault(); if (changed) act(api.patchTrait(t.id, { statement: draft.trim() })); }}
                >
                  <input
                    className="mb-input"
                    value={draft}
                    maxLength={160}
                    aria-label={`Edit trait (${TRAIT_LABEL[t.type]})`}
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  />
                  <button type="submit" className="rz-btn ghost mb-sm" disabled={busy || !changed}>Save</button>
                  <button
                    type="button"
                    className="rz-btn ghost mb-sm mb-remove"
                    disabled={busy}
                    aria-label={`Remove “${t.statement}”`}
                    onClick={() => act(api.deleteTrait(t.id))}
                  >
                    Remove
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="mb-traits">
          {traits.map((t) => (
            <li key={t.id} className={`mb-trait${t.level === "low" ? " low" : ""}`} title={`${TRAIT_LABEL[t.type]} · ${t.level} confidence · seen ${t.observations}×`}>
              {t.statement}
            </li>
          ))}
        </ul>
      )}

      {traits.length > 0 && <p className="mb-note">{explain}</p>}
      {editable && (
        <button
          type="button"
          className="rz-btn ghost mb-sm mb-edit"
          aria-expanded={editing}
          onClick={() => { setEditing((v) => !v); setDrafts({}); }}
        >
          {editing ? "Done" : "Edit traits"}
        </button>
      )}
    </section>
  );
}

// Only numbers the board actually has; a capped list shows "+".
function Glance({ m }: { m: MemberDetail }) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = m.timeline.filter((t) => t.at >= midnight.getTime()).length;
  const capped = (n: number, cap: number) => (n >= cap ? `${n}+` : String(n));
  const overlaps = m.handoffs.filter((h) => h.kind === "collision").length;
  const rows: [string, string, string?][] = [
    ["Last signal", timeAgo(m.lastSeen)],
    ["Updates today", capped(today, 40)],
    ["Files edited recently", capped(m.touches.length, 8)],
    ["Open handoffs", String(m.handoffs.length)],
  ];
  if (overlaps) rows.push(["Overlap heads-ups", String(overlaps), "pink"]);
  if (m.git) rows.push(["Uncommitted files", String(m.git.dirty)]);
  if (m.pending.length) rows.push(["Pending items", String(m.pending.length)]);
  return (
    <section className="rz-card mb-card" aria-labelledby="mb-gl-h">
      <h2 className="mb-h2" id="mb-gl-h">At a glance</h2>
      <dl className="mb-glance">
        {rows.map(([k, v, cls]) => (
          <div key={k}><dt>{k}</dt><dd className={cls}>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

function clock(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// The most recent 15 by default; the toggle reveals the rest or folds it back.
function Activity({ items }: { items: MemberDetail["timeline"] }) {
  const PAGE = 15;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, PAGE);
  const overflow = items.length - PAGE;
  return (
    <>
      <ol className="mb-activity">
        {shown.map((t, k) => (
          <li key={k} className={t.kind === "blocked" ? "blocked" : undefined}>
            <time dateTime={new Date(t.at).toISOString()} title={new Date(t.at).toLocaleString()}>{clock(t.at)}</time>
            <span className="mb-act-body"><span className="mb-act-kind">{t.kind}</span> {t.summary}</span>
          </li>
        ))}
      </ol>
      {overflow > 0 && (
        <button type="button" className="mb-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : `Show ${overflow} more`}
        </button>
      )}
    </>
  );
}

// Incoming handoffs: filter by kind, bulk-resolve (with confirmation), and the top
// 3 by default so the stack never eats the page; each resolved one drops out.
type HKind = MemberDetail["handoffs"][number]["kind"];
function Handoffs({ items, projectId, member, act, busy }: { items: MemberDetail["handoffs"]; projectId: string; member: string; act: Act; busy: boolean }) {
  const TOP = 3;
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | HKind>("all");
  const order: HKind[] = ["assignment", "mention", "blocker", "collision", "fyi"];
  const present = order.filter((k) => items.some((h) => h.kind === k));
  const active = filter !== "all" && !present.includes(filter) ? "all" : filter;
  const filtered = active === "all" ? items : items.filter((h) => h.kind === active);
  const shown = expanded ? filtered : filtered.slice(0, TOP);
  const overflow = filtered.length - TOP;

  const resolveAll = () => {
    const label = active === "all" ? "" : `${HKIND[active] || active} `;
    if (!window.confirm(`Resolve all ${filtered.length} ${label}handoff${filtered.length > 1 ? "s" : ""}? This can't be undone.`)) return;
    setExpanded(false);
    act(api.resolveHandoffs(projectId, member, active === "all" ? undefined : active));
  };

  return (
    <>
      <div className="mb-ho-bar">
        {present.length > 1 && (
          <div className="mb-filters" role="group" aria-label="Filter handoffs">
            {(["all", ...present] as const).map((k) => (
              <button key={k} type="button" className="mb-filter" aria-pressed={active === k} onClick={() => setFilter(k)}>
                {k === "all" ? `All ${items.length}` : `${HKIND[k] || k} ${items.filter((h) => h.kind === k).length}`}
              </button>
            ))}
          </div>
        )}
        {filtered.length > 1 && (
          <button type="button" className="rz-btn ghost mb-sm mb-remove" disabled={busy} onClick={resolveAll}>
            Resolve all ({filtered.length})
          </button>
        )}
      </div>
      <ul className="mb-hos">
        {shown.map((h) => (
          <li key={h.id} className={`mb-ho ${h.kind}`}>
            <div className="mb-ho-meta">
              <span className="mb-ho-kind">{HKIND[h.kind] || h.kind}</span>
              {h.from && <span>from {h.from}</span>}
              <span>{timeAgo(h.createdAt)}</span>
              {h.status === "ack" && <span className="mb-ackd">acknowledged</span>}
            </div>
            <p className="mb-ho-text">{h.text}</p>
            {!!h.conventions?.length && <p className="mb-note">Relevant conventions: {h.conventions.join("; ")}</p>}
            <div className="mb-ho-acts">
              {h.status === "open" && (
                <button type="button" className="rz-btn ghost mb-sm" disabled={busy} onClick={() => act(api.handoff(h.id, projectId, "ack"))}>Acknowledge</button>
              )}
              <button type="button" className="rz-btn ghost mb-sm" disabled={busy} onClick={() => act(api.handoff(h.id, projectId, "resolve"))}>Resolve</button>
            </div>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <button type="button" className="mb-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : `Show ${overflow} more`}
        </button>
      )}
    </>
  );
}

// Resolved handoffs, collapsed behind a count. One Reins closed on its own says
// why and can be reopened in one click.
function HandoffHistory({ items, projectId, act, busy }: { items: MemberDetail["resolvedHandoffs"]; projectId: string; act: Act; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && (
        <ul className="mb-rows">
          {items.map((h) => (
            <li key={h.id} className="mb-row mb-hist">
              <span className="mb-row-main">
                <span className="mb-k">{HKIND[h.kind] || h.kind}{h.from ? ` · ${h.from}` : ""}</span> {h.text}
                {h.autoClosed && (
                  <span className="mb-auto" title={h.autoClosed.event ? `event ${h.autoClosed.event}` : undefined}>auto-closed: {h.autoClosed.reason}</span>
                )}
              </span>
              {h.autoClosed
                ? <button type="button" className="rz-btn ghost mb-sm" disabled={busy} onClick={() => act(api.handoff(h.id, projectId, "reopen"))}>Reopen</button>
                : <span className="mb-row-side">{timeAgo(h.createdAt)}</span>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="mb-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Show less" : `Show ${items.length} resolved`}
      </button>
    </>
  );
}
