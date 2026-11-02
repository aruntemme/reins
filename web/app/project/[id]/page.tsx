"use client";
import "./project.css";
import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { ProjectTabs } from "@/components/project-tabs";
import { api, ApiError, errorMessage, timeAgo, type Project, type Goal, type GoalProposal, type Member, type Handoff } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { Mark } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import { Invite } from "@/components/invite";
import { ManageTokens } from "@/components/admin";
import {
  Lanes, PeopleList, Legend, HotFiles, useNow, rowsOf, collisionIds, caughtAt, blockedSince, isBranchArea, clock, span, WINDOW_MS,
} from "@/components/lanes";

type Viewer = { admin: boolean; me: string; auth: boolean };
type Act = (p: Promise<unknown>) => void;

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [proj, setProj] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  // A failed load that is not a 404 (server down, 5xx): transient, cleared on the next good load.
  const [loadErr, setLoadErr] = useState("");
  // The last failed board action (resync, ack/resolve/reopen), with the server's message.
  const [actErr, setActErr] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  // Already scoped server-side to what this caller can act on.
  const [proposals, setProposals] = useState<GoalProposal[]>([]);
  const [viewer, setViewer] = useState<Viewer>({ admin: false, me: "", auth: true });
  const [workspace, setWorkspace] = useState("");
  const now = useNow();

  useEffect(() => {
    api.me()
      .then((m) => {
        setViewer({
          admin: !!m.admin || !m.auth,
          // The account's capture identity marks "you" and who claims; falls back to
          // a local name only in the auth-off dev instance.
          me: m.member || m.user?.email || (!m.auth ? localStorage.getItem("reins-me") : "") || "",
          auth: m.auth,
        });
        setWorkspace(m.workspace?.name || "");
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      setProj(await api.project(id));
      setMissing(false);
      setLoadErr("");
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setLoadErr(errorMessage(e));
    }
  }, [id]);

  const fail = useCallback((e: unknown) => { if (!handleAuth(e)) setActErr(errorMessage(e)); }, []);
  const act = useCallback<Act>((p) => { setActErr(""); p.then(load, fail); }, [load, fail]);

  const loadGoals = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([api.goals(id), api.goalProposals(id)]);
      setGoals(g.goals);
      setProposals(p.proposals);
    } catch (e) { handleAuth(e); }
  }, [id]);

  const onChange = useCallback(() => { load(); loadGoals(); }, [load, loadGoals]);
  useEffect(() => { load(); loadGoals(); }, [load, loadGoals]);
  const live = useStream(id, onChange);

  const name = proj?.name || id;
  useEffect(() => { document.title = `${name} · Reins`; }, [name]);
  const enc = encodeURIComponent(id);
  const meInProject = !!viewer.me && !!proj?.members.some((m) => m.member === viewer.me);
  const liveCount = proj ? proj.members.filter((m) => m.live).length : 0;

  return (
    <div className="pj">
      <header className="pj-top">
        <div className="pj-top-l">
          <Link href="/dashboard" className="pj-logo" aria-label="Reins projects"><Mark size={36} /></Link>
          <nav aria-label="Breadcrumb" className="pj-crumbs">
            <ol>
              {workspace && <li className="pj-crumb-ws"><Link href="/dashboard">{workspace}</Link></li>}
              <li className="pj-crumb-cur" aria-current="page">{name}</li>
            </ol>
          </nav>
        </div>
        <nav aria-label="View" className="pj-views">
          <Link href={`/project/${enc}`} aria-current="page">Lanes</Link>
          {meInProject && <Link href={`/project/${enc}/${encodeURIComponent(viewer.me)}`}>Brief</Link>}
        </nav>
        <div className="pj-top-r">
          <span className={`pj-livecount${live && liveCount ? "" : " off"}`} role="status">
            <span className={`rz-live${live && liveCount ? "" : " away"}`} aria-hidden="true" />
            {!live ? "offline" : liveCount === 0 ? "nobody live" : <>{liveCount}<span className="pj-lc-long">&nbsp;agent{liveCount > 1 ? "s" : ""}</span>&nbsp;live</>}
          </span>
          {viewer.admin && <Link href={`/project/${enc}/lead`} className="pj-leadlink">Lead console</Link>}
          <UserMenu />
        </div>
      </header>

      {missing ? (
        <main className="pj-msg">No project “{id}”. <Link href="/dashboard">Back to projects</Link></main>
      ) : !proj ? (
        <main className="pj-msg">
          {loadErr ? (
            <>Could not load “{id}”: {loadErr} <button type="button" className="rz-btn ghost small" onClick={load}>Retry</button></>
          ) : "Loading…"}
        </main>
      ) : (
        <>
          <GoalBand proj={proj} goals={goals} proposals={proposals} onSaved={load} />
          <div className="pj-body">
            <main className="pj-main">
              {(loadErr || actErr) && (
                <p className="pj-err" role="alert">{actErr || `Could not refresh the board: ${loadErr}`}</p>
              )}
              <div className="pj-m-only"><Attention proj={proj} admin={viewer.admin} now={now} compact="overlaps" /></div>
              <Board proj={proj} viewer={viewer} now={now} />
            </main>
            <aside className="pj-rail" aria-label="Right now">
              <div className="pj-d-only"><Attention proj={proj} admin={viewer.admin} now={now} /></div>
              <div className="pj-m-only"><Attention proj={proj} admin={viewer.admin} now={now} compact="rest" /></div>
              <FromLead proj={proj} admin={viewer.admin} />
              <UpForGrabs proj={proj} viewer={viewer} onChange={onChange} />
              <Handoffs proj={proj} act={act} />
              <Summary proj={proj} act={act} />
            </aside>
          </div>
        </>
      )}

      <footer className="pj-foot">project · {id} · <Link href="/privacy">privacy</Link></footer>

      <ProjectTabs projectId={id} me={meInProject ? viewer.me : null} current="lanes" lead={viewer.admin} />
    </div>
  );
}

/** The slim sky band: the project goal (editable, as before) and team-goal progress. */
function GoalBand({ proj, goals, proposals, onSaved }: { proj: Project; goals: Goal[]; proposals: GoalProposal[]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proj.goal);
  const [err, setErr] = useState("");
  useEffect(() => setDraft(proj.goal), [proj.goal]);

  const save = async () => {
    setErr("");
    try {
      await api.setGoal(proj.id, draft.trim());
    } catch (e) {
      if (!handleAuth(e)) setErr(errorMessage(e));
      return;
    }
    setEditing(false);
    onSaved();
  };

  const team = goals.filter((g) => g.scope === "team" && !g.parentId);
  const steps = team.reduce((a, g) => ({ done: a.done + g.rollup.done, total: a.total + g.rollup.total }), { done: 0, total: 0 });
  const prog = steps.total > 0 ? steps : { done: team.filter((g) => g.status === "done").length, total: team.length };
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;

  return (
    <section aria-label="Goal" className="rz-field pj-band">
      <span className="rz-blob pj-band-blob" aria-hidden="true" />
      <div className="pj-band-in">
        {editing ? (
          <form className="pj-goal-edit" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label htmlFor="pj-goal" className="pj-band-k">Goal</label>
            <input id="pj-goal" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus placeholder="The goal this whole team is steering toward" />
            <button type="submit" className="rz-btn light small">Save goal</button>
            <button type="button" className="rz-btn small pj-band-ghost" onClick={() => { setEditing(false); setErr(""); setDraft(proj.goal); }}>Cancel</button>
            {err && <span className="pj-band-err" role="alert">{err}</span>}
          </form>
        ) : (
          <div className="pj-goal">
            <span className="pj-band-k">Goal</span>
            <span className="pj-goal-t">{proj.goal || "No goal yet. Set the one this whole team is steering toward."}</span>
            <button type="button" className="pj-goal-btn" onClick={() => setEditing(true)} aria-label={proj.goal ? "Edit the project goal" : "Set the project goal"}>
              {proj.goal ? "Edit" : "Set goal"}
            </button>
            {proj.goalSetBy && <span className="pj-band-by">set by {proj.goalSetBy}</span>}
          </div>
        )}
        <Link href={`/project/${encodeURIComponent(proj.id)}/lead`} className="pj-prog" aria-label={prog.total ? `Team goals: ${prog.done} of ${prog.total} done. Open goals` : "No team goals yet. Open goals"}>
          {prog.total ? (
            <>
              <span>{prog.done} of {prog.total} done</span>
              <span className="pj-prog-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
            </>
          ) : <span>No team goals yet</span>}
          {proposals.length > 0 && <span className="pj-pill">{proposals.length} to review</span>}
          <span aria-hidden="true">›</span>
        </Link>
      </div>
    </section>
  );
}

function Board({ proj, viewer, now }: { proj: Project; viewer: Viewer; now: number }) {
  const rows = rowsOf(proj, now, viewer.me);
  const anyLive = proj.members.some((m) => m.live);
  const enc = encodeURIComponent(proj.id);
  return (
    <>
      <div className="pj-h">
        <h1>Who is on what</h1>
        <span className="pj-quiet">
          <span className="pj-d-inline">last {WINDOW_MS / 60_000} minutes · </span>
          <span className="pj-m-inline">last hour · </span>
          {proj.members.length === 0 ? "waiting for the first agent" : anyLive ? "updates as agents work" : "nobody is live right now"}
        </span>
      </div>
      {proj.members.length === 0 ? (
        <div className="pj-empty">
          <p className="pj-empty-t">No agents connected yet.</p>
          <p className="pj-quiet">Lanes fill in as soon as a teammate’s agent sends its first edit.</p>
          <Link href={`/project/${enc}/connect`} className="rz-btn primary small">Connect an agent</Link>
        </div>
      ) : (
        <>
          <div className="pj-d-only"><Legend /></div>
          <div className="pj-d-only"><Lanes rows={rows} collisions={proj.collisions} members={proj.members} now={now} /></div>
          <div className="pj-m-only"><PeopleList rows={rows} now={now} /></div>
          <HotFiles members={proj.members} collisions={proj.collisions} now={now} />
        </>
      )}
    </>
  );
}

const assignHref = (projectId: string, area: string, suggest: string[] = []) =>
  `/project/${encodeURIComponent(projectId)}/lead?assign=${encodeURIComponent(area.slice(0, 200))}${suggest.length ? `&suggest=${encodeURIComponent(suggest.join(","))}` : ""}#assign`;
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Overlaps (pink), blocked teammates (amber) and synthesized risks. On phones it splits:
 *  `compact="overlaps"` sits above the people list, `compact="rest"` in the rail below it. */
function Attention({ proj, admin, now, compact }: { proj: Project; admin: boolean; now: number; compact?: "overlaps" | "rest" }) {
  const collisions = compact === "rest" ? [] : proj.rollup ? proj.rollup.collisions : proj.collisions;
  const blocked = compact === "overlaps" ? [] : proj.members.filter((m) => m.displayStatus === "blocked");
  const risks = compact === "overlaps" ? [] : proj.rollup?.risks ?? [];
  const enc = encodeURIComponent(proj.id);
  if (compact && collisions.length === 0 && blocked.length === 0 && risks.length === 0) return null;

  return (
    <section className="pj-sec" aria-labelledby={compact ? `pj-att-${compact}` : "pj-att"}>
      <h2 id={compact ? `pj-att-${compact}` : "pj-att"} className={`rz-section-h${compact === "overlaps" ? " pj-sr" : ""}`}>Needs attention</h2>
      {collisions.length === 0 && blocked.length === 0 && risks.length === 0 && (
        <p className="pj-quiet">Nothing needs you. No overlaps, nobody blocked.</p>
      )}
      {collisions.map((c, i) => {
        const caught = c.computed ? caughtAt(c, proj.members) : null;
        const branch = isBranchArea(c.area);
        return (
          <article key={`c${i}`} className="pj-att ov">
            <span className="pj-att-k"><span className="pj-pip" aria-hidden="true" />
              {c.computed ? (caught?.sent ? `Heads-up sent · ${clock(caught.at)}` : "Overlap · live") : "Possible overlap"}
            </span>
            <span className="pj-att-t">
              {c.computed ? (
                branch
                  ? <>{andList(c.members)} are both on <span className="pj-mono">{c.area.replace(/^branch /, "")}</span>.</>
                  : <>{andList(c.members)} both reached for <span className="pj-mono">{c.area}</span>.</>
              ) : (
                <><span className="pj-mono">{c.area}</span> · {andList(c.members)}{c.note ? `: ${c.note}` : ""}</>
              )}
            </span>
            {admin && (
              <Link className="rz-btn ghost small pj-att-a" href={assignHref(proj.id, c.area.replace(/^branch /, ""), collisionIds(c, proj.members))}>
                Assign an owner
              </Link>
            )}
          </article>
        );
      })}
      {blocked.map((m) => {
        const b = blockedSince(m);
        const why = b?.why || m.headline;
        return (
          <article key={m.member} className="pj-att bl">
            <span className="pj-att-k"><span className="pj-pip" aria-hidden="true" />Blocked{b ? ` · ${span(Math.min(b.at, now))}` : ""}</span>
            <span className="pj-att-t">{m.displayName} is blocked{why ? `: ${why}` : "."}</span>
            <Link className="rz-btn ghost small pj-att-a" href={`/project/${enc}/${encodeURIComponent(m.member)}`}>Open {m.displayName}’s brief</Link>
          </article>
        );
      })}
      {risks.map((r, i) => (
        <article key={`r${i}`} className="pj-att">
          <span className="pj-att-k">Risk</span>
          <span className="pj-att-t">{r}</span>
        </article>
      ))}
    </section>
  );
}

function untilLabel(ts: number): string {
  const h = Math.max(0, (ts - Date.now()) / 3_600_000);
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m left` : h < 48 ? `${Math.round(h)}h left` : `${Math.round(h / 24)}d left`;
}

/** Active directives and assignments, read-only here; leads post and clear them in the console. */
function FromLead({ proj, admin }: { proj: Project; admin: boolean }) {
  const nameOf = (id: string) => proj.members.find((m) => m.member === id)?.displayName || id;
  const empty = proj.directives.length === 0 && proj.assignments.length === 0;
  return (
    <section className="pj-sec" aria-labelledby="pj-lead">
      <h2 id="pj-lead" className="rz-section-h">From the lead</h2>
      {empty && (
        <p className="pj-quiet">
          Nothing from the lead right now.
          {admin && <> <Link href={`/project/${encodeURIComponent(proj.id)}/lead`} className="pj-a">Post a directive</Link></>}
        </p>
      )}
      {proj.directives.map((d) => (
        <div key={d.id} className="pj-dir">
          <p className="pj-dir-t">“{d.text}”</p>
          <span className="pj-quiet">
            to {d.targets.length ? d.targets.map(nameOf).join(", ") : "the whole team"} · {untilLabel(d.expiresAt)}{d.by ? ` · ${d.by}` : ""}
          </span>
        </div>
      ))}
      {proj.assignments.map((a) => (
        <div key={a.id} className="pj-asg">
          <span><span className="pj-mono">{a.area}</span> → <b>{nameOf(a.member)}</b></span>
          <span className="pj-quiet">assigned {timeAgo(a.createdAt)}{a.by ? ` by ${a.by}` : ""}{a.note ? ` · ${a.note}` : ""}</span>
        </div>
      ))}
    </section>
  );
}

function UpForGrabs({ proj, viewer, onChange }: { proj: Project; viewer: Viewer; onChange: () => void }) {
  const [local, setLocal] = useState("");
  const [err, setErr] = useState("");
  // Claim as the signed-in account. Only the auth-off local instance (no
  // accounts) asks for a name, remembered in localStorage.
  const who = (): string | null => {
    if (viewer.me) return viewer.me;
    if (viewer.auth) return null;
    let v = local;
    if (!v) { v = prompt("Your name (so peers know who claimed it):") || "someone"; localStorage.setItem("reins-me", v); setLocal(v); }
    return v;
  };
  // A failure (e.g. 409: someone else got there first) shows the server's reason
  // and refreshes so the board reflects what actually happened.
  const run = (p: Promise<unknown>) => {
    setErr("");
    p.then(onChange, (e) => { if (!handleAuth(e)) { setErr(errorMessage(e)); onChange(); } });
  };
  const claim = (id: string) => {
    const by = who();
    if (!by) { setErr("Log in with your account to claim items."); return; }
    run(api.claim(id, proj.id, by));
  };
  const open = proj.pending.filter((p) => p.status !== "done");

  return (
    <section className="pj-sec" aria-labelledby="pj-grabs">
      <h2 id="pj-grabs" className="rz-section-h">Up for grabs</h2>
      {err && <p className="pj-err" role="alert">{err}</p>}
      {open.length === 0 ? (
        <p className="pj-quiet">Nothing waiting. Clean board.</p>
      ) : (
        open.map((p) => (
          <div className="pj-grab" key={p.id}>
            <div className="pj-grab-t">
              <span>{p.text}</span>
              <span className="pj-quiet">from {p.member}{p.status === "claimed" && p.claimedBy ? ` · ${p.claimedBy} on it` : ""}</span>
            </div>
            <div className="pj-grab-a">
              {p.status === "open"
                ? <button type="button" className="pj-btn sky" onClick={() => claim(p.id)}>Claim</button>
                : <span className="pj-claimed">Claimed</span>}
              <button type="button" className="pj-btn" onClick={() => run(api.done(p.id, proj.id))} aria-label={`Mark done: ${p.text}`}>Done</button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

const HKIND: Record<string, string> = { mention: "@mention", collision: "Overlap", blocker: "Blocker", fyi: "FYI", assignment: "Assignment" };
const SHOW = 4;

/** Every open handoff on the team, with ack/resolve, then the ones Reins closed itself (reopen). */
function Handoffs({ proj, act }: { proj: Project; act: Act }) {
  const [all, setAll] = useState(false);
  const nameOf = (id: string) => proj.members.find((m) => m.member === id)?.displayName || id;
  const open: { h: Handoff; to: Member }[] = proj.members.flatMap((m) => m.handoffs.map((h) => ({ h, to: m })));
  const closed: { h: Handoff; to: Member }[] = proj.members.flatMap((m) => m.autoClosed.map((h) => ({ h, to: m })));
  open.sort((a, b) => b.h.createdAt - a.h.createdAt);
  const shown = all ? open : open.slice(0, SHOW);

  return (
    <section className="pj-sec" aria-labelledby="pj-hand">
      <h2 id="pj-hand" className="rz-section-h">Handoffs{open.length > 0 ? ` · ${open.length} open` : ""}</h2>
      {open.length === 0 && closed.length === 0 && <p className="pj-quiet">No open handoffs.</p>}
      {shown.map(({ h, to }) => (
        <div key={h.id} className={`pj-ho${h.kind === "collision" ? " ov" : h.kind === "blocker" ? " bl" : ""}`}>
          <span className="pj-ho-k">
            {HKIND[h.kind] || h.kind}
            <span className="pj-ho-route">
              {h.from ? nameOf(h.from) : "Reins"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-label="to"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              {to.displayName}
            </span>
            {h.status === "ack" && <span className="pj-quiet">ack’d</span>}
          </span>
          <span className="pj-ho-t">{h.text}</span>
          {!!h.conventions?.length && <span className="pj-quiet">their conventions: {h.conventions.join("; ")}</span>}
          <span className="pj-ho-a">
            {h.status === "open" && <button type="button" className="pj-btn" onClick={() => act(api.handoff(h.id, proj.id, "ack"))}>Ack</button>}
            <button type="button" className="pj-btn" onClick={() => act(api.handoff(h.id, proj.id, "resolve"))}>Resolve</button>
          </span>
        </div>
      ))}
      {open.length > SHOW && (
        <button type="button" className="pj-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${open.length}`}
        </button>
      )}
      {closed.length > 0 && (
        <div className="pj-closed">
          <span className="pj-quiet">Closed on their own</span>
          {closed.map(({ h, to }) => (
            <div key={h.id} className="pj-closed-r" title={h.text}>
              <span>
                <span className="pj-mono">{HKIND[h.kind] || h.kind} · {h.from ? `${nameOf(h.from)} → ` : ""}{to.displayName}</span>
                <span className="pj-quiet">{h.autoClosed?.reason || "no longer applies"}</span>
              </span>
              <button type="button" className="pj-btn" onClick={() => act(api.handoff(h.id, proj.id, "reopen"))}>Reopen</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The synthesized team status, a manual resync, and the team tools (invite, tokens) for admins. */
function Summary({ proj, act }: { proj: Project; act: Act }) {
  const r = proj.rollup;
  return (
    <section className="pj-sec" aria-labelledby="pj-sum">
      <h2 id="pj-sum" className="rz-section-h">Team summary</h2>
      {r ? (
        <>
          <p className="pj-sum-t">{r.summary}</p>
          {r.alignment && <p className="pj-quiet"><b>Goal alignment:</b> {r.alignment}</p>}
          <span className="pj-quiet">synthesized {timeAgo(r.updatedAt)}</span>
        </>
      ) : (
        <p className="pj-quiet">No summary yet. It synthesizes after the team logs a bit of activity.</p>
      )}
      <div className="pj-tools">
        <button type="button" className="rz-btn ghost small" onClick={() => act(api.refreshRollup(proj.id))}>Resync</button>
        <Invite projectId={proj.id} />
        <ManageTokens />
      </div>
    </section>
  );
}
