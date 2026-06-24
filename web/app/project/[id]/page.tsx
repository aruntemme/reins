"use client";
import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { api, timeAgo, type Project } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar, Avatar, STATUS } from "@/components/ui";
import { Invite } from "@/components/invite";

export default function Dashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [proj, setProj] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setProj(await api.project(id));
    } catch (e) {
      if (handleAuth(e)) return;
      setMissing(true);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  const live = useStream(id, load);

  if (missing) return (
    <><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash"><div className="card pad empty">No project “{id}”. <Link href="/dashboard" className="hl">Back</Link></div></div></main></>
  );
  if (!proj) return (
    <><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash"><div className="empty">Loading…</div></div></main></>
  );

  return (
    <>
      <TopBar
        live={live}
        right={<button className="btn ghost" onClick={() => api.refreshRollup(id).then(load)}>resync</button>}
      />
      <main className="wrap">
        <div className="dash">
          <DashHead proj={proj} onSaved={load} />
          <div className="cols">
            <div style={{ display: "grid", gap: 24 }}>
              <Rollup proj={proj} />
              <div>
                <div className="label" style={{ marginBottom: 14, justifyContent: "space-between", display: "flex", alignItems: "center" }}>
                  <span><span className="sq active" /> team · live</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {proj.handoffs.length > 0 && (
                      <span className="hcount"><span className="sq blocked" /> {proj.handoffs.length} open handoff{proj.handoffs.length > 1 ? "s" : ""}</span>
                    )}
                    <Invite projectId={id} />
                  </span>
                </div>
                {proj.members.length === 0 ? (
                  <div className="card pad empty">No activity captured yet.</div>
                ) : (
                  <div className="team">
                    {proj.members.map((m, i) => <MemberCard key={m.member} m={m} i={i} projectId={proj.id} onAct={load} />)}
                  </div>
                )}
              </div>
            </div>
            <PendingRail proj={proj} onChange={load} />
          </div>
        </div>
      </main>
      <footer className="foot"><div className="wrap">project · {proj.id}</div></footer>
    </>
  );
}

function DashHead({ proj, onSaved }: { proj: Project; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proj.goal);
  useEffect(() => setDraft(proj.goal), [proj.goal]);

  const save = async () => {
    await api.setGoal(proj.id, draft.trim());
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
              <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="goaltext">{proj.goal || "Set the goal this whole team is steering toward…"}</div>
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
      </div>
    </div>
  );
}

function Rollup({ proj }: { proj: Project }) {
  const r = proj.rollup;
  if (!r) return (
    <div className="card pad">
      <div className="label" style={{ marginBottom: 10 }}><span className="sq" /> status</div>
      <div className="empty">No rollup yet. It synthesizes after the team logs a bit of activity.</div>
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
        {(r.risks.length > 0 || r.collisions.length > 0) && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}><span className="sq blocked" /> watch</div>
            <div className="chiprow">
              {r.collisions.map((c, i) => (
                <span key={`c${i}`} className="chip warn" title={c.note}>⚠ {c.area} · {c.members.join(", ")}</span>
              ))}
              {r.risks.map((x, i) => <span key={`r${i}`} className="chip warn">{x}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const HKIND: Record<string, string> = { mention: "@mention", collision: "collision", blocker: "blocker", fyi: "fyi" };

function MemberCard({ m, i, projectId, onAct }: { m: Project["members"][number]; i: number; projectId: string; onAct: () => void }) {
  const s = STATUS[m.displayStatus] ?? STATUS.idle;
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <Link href={`/project/${encodeURIComponent(projectId)}/${encodeURIComponent(m.member)}`} className={`card mcard${m.live ? "" : " stale"}`}>
      <div className="top">
        <div className="who">
          <Avatar name={m.displayName} i={i} />
          <div>
            <div className="name">{m.displayName}</div>
            <div className="mono">{m.live ? `active · ${timeAgo(m.lastSeen)}` : `last seen ${timeAgo(m.lastSeen)}`}</div>
          </div>
        </div>
        <span className="statuslabel"><span className={`sq ${s.cls}`} /> {s.label}</span>
      </div>
      {m.handoffs.length > 0 && (
        <div className="handoffs">
          {m.handoffs.map((h) => (
            <div className={`handoff ${h.kind}${h.status === "ack" ? " ackd" : ""}`} key={h.id}>
              <div className="hmeta">
                <span className="hkind">{HKIND[h.kind] || h.kind}{h.from ? ` · ${h.from}` : ""}</span>
                {h.status === "ack" && <span className="mono">ack’d</span>}
              </div>
              <div className="htext">{h.text}</div>
              <div className="hacts">
                {h.status === "open" && (
                  <button className="tiny" onClick={(e) => { stop(e); api.handoff(h.id, projectId, "ack").then(onAct); }}>ack</button>
                )}
                <button className="tiny" onClick={(e) => { stop(e); api.handoff(h.id, projectId, "resolve").then(onAct); }}>resolve</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="headline">{m.headline || "…"}</div>
      {m.goal && <div className="goal">{m.goal}</div>}
      {m.workingOn.length > 0 && (
        <div className="chiprow">
          {m.workingOn.map((w, k) => <span key={k} className="chip">{w}</span>)}
        </div>
      )}
      {m.timeline.length > 0 && (
        <div className="timeline">
          {m.timeline.slice(0, 4).map((t, k) => (
            <div className="tl" key={k}><span className="tk">{t.kind}</span><span>{t.summary}</span></div>
          ))}
        </div>
      )}
    </Link>
  );
}

function PendingRail({ proj, onChange }: { proj: Project; onChange: () => void }) {
  const [me, setMe] = useState("");
  useEffect(() => { setMe(localStorage.getItem("reins-me") || ""); }, []);
  const who = () => {
    let v = me;
    if (!v) { v = prompt("Your name (so peers know who claimed it):") || "someone"; localStorage.setItem("reins-me", v); setMe(v); }
    return v;
  };
  const open = proj.pending.filter((p) => p.status !== "done");

  return (
    <div className="rail">
      <div className="card pend">
        <div className="label"><span className="sq" /> pending · up for grabs</div>
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
                    <button className="tiny" onClick={() => api.claim(p.id, proj.id, who()).then(onChange)}>claim</button>
                  ) : (
                    <span className="tiny claimed">claimed</span>
                  )}
                  <button className="tiny" onClick={() => api.done(p.id, proj.id).then(onChange)}>done</button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
