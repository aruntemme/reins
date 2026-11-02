"use client";
import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { api, ApiError, errorMessage, timeAgo, type Project, type Goal, type GoalProposal } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar, Avatar, STATUS } from "@/components/ui";
import { Invite } from "@/components/invite";
import { ManageTokens } from "@/components/admin";
import { GoalsDrawer, GoalsRef } from "@/components/goals";
import { LeadPanel, AssignForm, AutoClosedList, gitLabel } from "@/components/lead";

type Viewer = { admin: boolean; me: string; auth: boolean };

export default function Dashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [proj, setProj] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  // A failed load that is not a 404 (server down, 5xx): transient, cleared on the next good load.
  const [loadErr, setLoadErr] = useState("");
  // The last failed board action (resync, ack/resolve), with the server's message.
  const [actErr, setActErr] = useState("");

  const [goals, setGoals] = useState<Goal[]>([]);
  const [proposals, setProposals] = useState<GoalProposal[]>([]);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [viewer, setViewer] = useState<Viewer>({ admin: false, me: "", auth: true });

  useEffect(() => {
    api.me()
      .then((m) =>
        setViewer({
          admin: !!m.admin || !m.auth,
          // The account's capture identity drives which goals are "mine" and who
          // claims; falls back to a local name only in the auth-off dev instance.
          me: m.member || m.user?.email || (!m.auth ? localStorage.getItem("reins-me") : "") || "",
          auth: m.auth,
        })
      )
      .catch(() => {});
  }, []);

  // Proposals are already scoped server-side to what this caller can act on
  // (team -> admins, individual -> the owning teammate), so use them directly.
  const myProposals = proposals;

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
  const act = useCallback((p: Promise<unknown>) => { setActErr(""); p.then(load, fail); }, [load, fail]);

  const loadGoals = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([api.goals(id), api.goalProposals(id)]);
      setGoals(g.goals);
      setProposals(p.proposals);
    } catch (e) { handleAuth(e); }
  }, [id]);

  // One change handler drives both the board and the goals pane off the same SSE.
  const onChange = useCallback(() => { load(); loadGoals(); }, [load, loadGoals]);
  useEffect(() => { load(); loadGoals(); }, [load, loadGoals]);
  const live = useStream(id, onChange);

  if (missing) return (
    <><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash"><div className="card pad empty">No project “{id}”. <Link href="/dashboard" className="hl">Back</Link></div></div></main></>
  );
  if (!proj) return (
    <><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash">
      {loadErr ? (
        <div className="card pad empty">
          <span className="mono" style={{ color: "var(--blocked)" }}>Could not load “{id}”: {loadErr}</span>{" "}
          <button className="tiny" onClick={load}>retry</button>
        </div>
      ) : <div className="empty">Loading…</div>}
    </div></main></>
  );

  return (
    <>
      <TopBar
        live={live}
        right={<button className="btn ghost" onClick={() => act(api.refreshRollup(id))}>resync</button>}
      />
      <main className="wrap">
        <div className="dash">
          <DashHead proj={proj} goals={goals} proposals={myProposals} onSaved={load} onOpenGoals={() => setGoalsOpen(true)} />
          {(loadErr || actErr) && (
            <div className="mono" style={{ color: "var(--blocked)" }}>{actErr || `Could not refresh the board: ${loadErr}`}</div>
          )}
          <div className="cols">
            <div style={{ display: "grid", gap: 24 }}>
              <Rollup proj={proj} admin={viewer.admin} onChange={load} />
              <div>
                <div className="label teamhead">
                  <span><span className="sq active" /> team · live</span>
                  <span className="teamhead-acts">
                    {proj.handoffs.length > 0 && (
                      <span className="hcount"><span className="sq blocked" /> {proj.handoffs.length} open handoff{proj.handoffs.length > 1 ? "s" : ""}</span>
                    )}
                    <Invite projectId={id} />
                    <ManageTokens />
                  </span>
                </div>
                {proj.members.length === 0 ? (
                  <div className="card pad empty">No activity captured yet.</div>
                ) : (
                  <div className="team">
                    {proj.members.map((m, i) => (
                      <MemberCard
                        key={m.member} m={m} i={i} projectId={proj.id} act={act}
                        assigned={proj.assignments.filter((a) => a.member === m.member).map((a) => a.area)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="rail">
              <LeadPanel proj={proj} admin={viewer.admin} onChange={load} />
              <PendingRail proj={proj} viewer={viewer} onChange={onChange} />
            </div>
          </div>
        </div>
      </main>
      <GoalsDrawer open={goalsOpen} onClose={() => setGoalsOpen(false)} projectId={proj.id} goals={goals} proposals={myProposals} viewer={viewer} onChange={onChange} />
      <footer className="foot"><div className="wrap">project · {proj.id} · <Link href="/privacy">privacy</Link></div></footer>
    </>
  );
}

function DashHead({ proj, goals, proposals, onSaved, onOpenGoals }: { proj: Project; goals: Goal[]; proposals: GoalProposal[]; onSaved: () => void; onOpenGoals: () => void }) {
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

  return (
    <div className="dashhead">
      <div className="crumbs">
        <Link href="/dashboard" className="mono">‹ projects</Link>
        <span className="mono">/</span>
        <span className="label"><span className="sq" /> {proj.id}</span>
      </div>
      <div className="label"><span className="sq blue" /> global goal{proj.goalSetBy ? ` · set by ${proj.goalSetBy}` : ""}</div>
      <div className="goalbox">
        {editing ? (
          <div style={{ flex: 1, display: "grid", gap: 10 }}>
            <textarea value={draft} rows={2} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn solid" onClick={save}>Save goal</button>
              <button className="btn ghost" onClick={() => { setEditing(false); setErr(""); }}>Cancel</button>
            </div>
            {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
          </div>
        ) : (
          <>
            <div className="goaltext">{proj.goal || "Set the goal this whole team is steering toward…"}</div>
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
      </div>
      <GoalsRef goals={goals} proposals={proposals} onOpen={onOpenGoals} />
    </div>
  );
}

function Rollup({ proj, admin, onChange }: { proj: Project; admin: boolean; onChange: () => void }) {
  const r = proj.rollup;
  // Which card is being assigned: "c<i>" for a collision, "r<i>" for a risk.
  const [assigning, setAssigning] = useState<string | null>(null);
  // Live overlaps show even before the first rollup is synthesized.
  const collisions = r ? r.collisions : proj.collisions;
  const risks = r ? r.risks : [];
  const idOf = (name: string) => proj.members.find((m) => m.displayName === name || m.member === name)?.member;
  const openForm = (() => {
    if (!assigning) return null;
    const i = Number(assigning.slice(1));
    if (assigning[0] === "c" && collisions[i]) {
      const c = collisions[i]!;
      return { area: c.area.replace(/^branch /, ""), suggested: c.members.map(idOf).filter(Boolean) as string[] };
    }
    if (assigning[0] === "r" && risks[i]) return { area: risks[i]!.slice(0, 200), suggested: [] };
    return null;
  })();

  const watch = (collisions.length > 0 || risks.length > 0) && (
    <div>
      <div className="label" style={{ marginBottom: 6 }}><span className="sq blocked" /> watch</div>
      <div className="chiprow">
        {collisions.map((c, i) => (
          <span key={`c${i}`} className="chip warn chipact" title={c.note}>
            ⚠ {c.area} · {c.members.join(", ")}
            {admin && <button className="chipbtn" onClick={() => setAssigning(`c${i}`)} aria-label={`assign ${c.area}`}>assign</button>}
          </span>
        ))}
        {risks.map((x, i) => (
          <span key={`r${i}`} className="chip warn chipact">
            {x}
            {admin && <button className="chipbtn" onClick={() => setAssigning(`r${i}`)} aria-label="assign an owner for this risk">assign</button>}
          </span>
        ))}
      </div>
      {openForm && (
        <AssignForm
          key={assigning}
          proj={proj}
          area={openForm.area}
          suggested={openForm.suggested}
          onCancel={() => setAssigning(null)}
          onDone={() => { setAssigning(null); onChange(); }}
        />
      )}
    </div>
  );

  if (!r) return (
    <div className="card pad rollup">
      <div className="label"><span className="sq" /> status</div>
      <div className="empty">No rollup yet. It synthesizes after the team logs a bit of activity.</div>
      {watch}
    </div>
  );
  return (
    <div className="card pad rollup">
      <div className="label"><span className="sq" /> status · synthesized {timeAgo(r.updatedAt)}</div>
      <div className="summary">{r.summary}</div>
      <div className="meta">
        {r.alignment && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}><span className="sq blue" /> goal alignment</div>
            <div className="sub" style={{ fontSize: 14 }}>{r.alignment}</div>
          </div>
        )}
        {watch}
      </div>
    </div>
  );
}

const HKIND: Record<string, string> = { mention: "@mention", collision: "collision", blocker: "blocker", fyi: "fyi", assignment: "assignment" };

// The member's name is the link (not the whole card), so the handoff buttons
// inside the card are never nested in an interactive element.
function MemberCard({ m, i, projectId, assigned, act }: { m: Project["members"][number]; i: number; projectId: string; assigned: string[]; act: (p: Promise<unknown>) => void }) {
  const s = STATUS[m.displayStatus] ?? STATUS.idle;
  const git = gitLabel(m);
  // Real edits first; inferred working-on entries that repeat one are dropped.
  const touched = new Set(m.touches.map((t) => t.path.toLowerCase()));
  const inferred = m.workingOn.filter((w) => ![...touched].some((t) => t === w.toLowerCase() || t.endsWith(`/${w.toLowerCase()}`)));
  return (
    <div className={`card mcard${m.live ? "" : " stale"}`}>
      <div className="top">
        <div className="who">
          <Avatar name={m.displayName} i={i} />
          <div>
            <Link href={`/project/${encodeURIComponent(projectId)}/${encodeURIComponent(m.member)}`} className="name">{m.displayName}</Link>
            <div className="mono">{m.live ? `active · ${timeAgo(m.lastSeen)}` : `last seen ${timeAgo(m.lastSeen)}`}</div>
            {git && <div className="mono gitline" title={m.git?.head ? `HEAD ${m.git.head}` : undefined}>{git}</div>}
          </div>
        </div>
        <span className="statuslabel"><span className={`sq ${s.cls}`} /> {s.label}</span>
      </div>
      {m.handoffs.length > 0 && <Handoffs items={m.handoffs} projectId={projectId} act={act} />}
      <AutoClosedList items={m.autoClosed} projectId={projectId} act={act} />
      <div className="headline">{m.headline || "…"}</div>
      {m.goal && <div className="goal">{m.goal}</div>}
      {(m.touches.length > 0 || inferred.length > 0 || assigned.length > 0) && (
        <div className="chiprow">
          {assigned.map((a) => <span key={`a${a}`} className="chip owns" title="assigned by the lead">owns {a}</span>)}
          {m.touches.map((t) => <span key={`t${t.path}`} className="chip edited" title={`edited ${timeAgo(t.at)}`}>✎ {t.path}</span>)}
          {inferred.map((w, k) => <span key={k} className="chip">{w}</span>)}
        </div>
      )}
      {m.timeline.length > 0 && (
        <div className="timeline">
          {m.timeline.slice(0, 4).map((t, k) => (
            <div className="tl" key={k}><span className="tk">{t.kind}</span><span>{t.summary}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

// Incoming handoffs for a member. More than a couple would balloon the card, so
// they collapse behind a count (with a kind breakdown) and expand on click.
function Handoffs({ items, projectId, act }: { items: Project["members"][number]["handoffs"]; projectId: string; act: (p: Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const COLLAPSE_AT = 2;
  const collapsed = items.length > COLLAPSE_AT && !open;

  if (collapsed) {
    const counts = items.reduce<Record<string, number>>((a, h) => ((a[h.kind] = (a[h.kind] || 0) + 1), a), {});
    const breakdown = Object.entries(counts)
      .map(([k, n]) => `${n} ${HKIND[k] || k}${n > 1 ? "s" : ""}`)
      .join(" · ");
    return (
      <button className="handoff-collapse" onClick={() => setOpen(true)}>
        <span className="sq blocked" />
        <span className="hc-n">{items.length} for you</span>
        <span className="mono hc-b">{breakdown}</span>
        <span className="hc-x">▾</span>
      </button>
    );
  }

  return (
    <div className="handoffs">
      {items.length > COLLAPSE_AT && (
        <button className="handoff-collapse hide" onClick={() => setOpen(false)}>
          <span className="hc-x">▴</span> <span className="mono">{items.length} for you · collapse</span>
        </button>
      )}
      {items.map((h) => (
        <div className={`handoff ${h.kind}${h.status === "ack" ? " ackd" : ""}`} key={h.id}>
          <div className="hmeta">
            <span className="hkind">{HKIND[h.kind] || h.kind}{h.from ? ` · ${h.from}` : ""}</span>
            {h.status === "ack" && <span className="mono">ack’d</span>}
          </div>
          <div className="htext">{h.text}</div>
          {!!h.conventions?.length && <div className="hconv">their conventions: {h.conventions.join("; ")}</div>}
          <div className="hacts">
            {h.status === "open" && (
              <button className="tiny" onClick={() => act(api.handoff(h.id, projectId, "ack"))}>ack</button>
            )}
            <button className="tiny" onClick={() => act(api.handoff(h.id, projectId, "resolve"))}>resolve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function PendingRail({ proj, viewer, onChange }: { proj: Project; viewer: Viewer; onChange: () => void }) {
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
    <div className="card pend">
      <div className="label"><span className="sq" /> pending · up for grabs</div>
      {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
        {open.length === 0 ? (
          <div className="empty">Nothing waiting. Clean board.</div>
        ) : (
          open.map((p) => (
            <div className="pitem" key={p.id}>
              <div className="ptext">{p.text}</div>
              <div className="pmeta">
                <span className="mono">
                  from {p.member}{p.status === "claimed" && p.claimedBy ? ` · ${p.claimedBy} on it` : ""}
                </span>
                <div className="acts">
                  {p.status === "open" ? (
                    <button className="tiny" onClick={() => claim(p.id)}>claim</button>
                  ) : (
                    <span className="tiny claimed">claimed</span>
                  )}
                  <button className="tiny" onClick={() => run(api.done(p.id, proj.id))}>done</button>
                </div>
              </div>
            </div>
          ))
        )}
    </div>
  );
}
