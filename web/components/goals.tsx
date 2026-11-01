"use client";
import { useState } from "react";
import Link from "next/link";
import { api, type Goal, type GoalProgress, type GoalProposal, type GoalScope } from "@/lib/api";
import { useRun } from "@/components/lead";

// Who is looking: me is the account's capture identity ("" if unknown); auth is
// false only on the auth-off local instance, the one place we ask for a name.
export type Viewer = { admin: boolean; me: string; auth: boolean };

const STATUS_LABEL: Record<Goal["status"], string> = { todo: "to do", in_progress: "in progress", blocked: "blocked", done: "done" };

/** Compact goals summary for the lanes header; links to (or opens) the full goals view. */
export function GoalsRef({ goals, proposals, onOpen, href }: { goals: Goal[]; proposals: GoalProposal[]; onOpen?: () => void; href?: string }) {
  const n = (s: string) => goals.filter((g) => g.status === s).length;
  const done = n("done"), prog = n("in_progress"), blocked = n("blocked"), todo = n("todo");
  const body = (
    <>
      <span>Goals</span>
      {goals.length === 0 ? (
        <span>none yet</span>
      ) : (
        <span>
          <b>{done}</b> done · <b>{prog}</b> in progress{blocked > 0 && <> · <b>{blocked}</b> blocked</>} · <b>{todo}</b> to do
        </span>
      )}
      {proposals.length > 0 && <span>· {proposals.length} suggested</span>}
      <span aria-hidden="true">›</span>
    </>
  );
  const style = { minHeight: 44, fontFamily: "inherit", cursor: "pointer" };
  return href ? (
    <Link href={href} className="rz-chip goals-ref" style={style}>{body}</Link>
  ) : (
    <button type="button" className="rz-chip goals-ref" style={style} onClick={onOpen}>{body}</button>
  );
}

function Ring({ p }: { p: GoalProgress }) {
  const C = 2 * Math.PI * 15;
  return (
    <svg className="ld-ring" viewBox="0 0 36 36" role="img" aria-label={`${p.done} of ${p.total} steps done`}>
      <circle className="trk" cx="18" cy="18" r="15" fill="none" strokeWidth="4" />
      {p.done > 0 && (
        <circle
          className="val" cx="18" cy="18" r="15" fill="none" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${((p.pct / 100) * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 18 18)"
        />
      )}
      <text x="18" y="21" textAnchor="middle">{p.done}/{p.total}</text>
    </svg>
  );
}

/**
 * Short-term goals: common TEAM goals (owner/admin-managed, progress ring) and
 * per-person goals (only their owner edits them). Each is a checklist.
 */
export function Goals({
  projectId, goals, viewer, nameOf, onChange,
}: { projectId: string; goals: Goal[]; viewer: Viewer; nameOf: (id: string) => string; onChange: () => void }) {
  const { err, busy, run } = useRun(onChange);
  const [local, setLocal] = useState("");
  const me = viewer.me || local;
  // Your goals belong to your account's identity; only the auth-off local
  // instance (no accounts) asks for a name.
  const canMine = !!me || !viewer.auth;
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<GoalScope>(viewer.admin ? "team" : "individual");
  const sc: GoalScope = viewer.admin && (scope === "team" || !canMine) ? "team" : "individual";

  const team = goals.filter((g) => g.scope === "team");
  const mine = goals.filter((g) => g.scope === "individual" && !!me && g.member === me);
  const others = goals.filter((g) => g.scope === "individual" && (!me || g.member !== me));
  const titleOf = (id: string | null) => (id ? goals.find((g) => g.id === id)?.title : undefined);

  const add = () => {
    const t = title.trim();
    if (!t || busy) return;
    const done = () => { setTitle(""); setAdding(false); };
    if (sc === "team") return run(api.addGoal(projectId, { scope: "team", title: t }), done);
    let member = me;
    if (!member) {
      member = (prompt("Your name (the identity your agent reports as):") || "").trim();
      if (!member) return;
      localStorage.setItem("reins-me", member);
      setLocal(member);
    }
    run(api.addGoal(projectId, { scope: "individual", member, title: t }), done);
  };

  return (
    <section className="ld-card" aria-labelledby="ld-goals-h">
      <div className="ld-card-h">
        <h2 id="ld-goals-h">Goals</h2>
        {(viewer.admin || canMine) && (
          <button type="button" className="ld-ghost" aria-expanded={adding} aria-controls="ld-goal-form" onClick={() => setAdding((a) => !a)}>
            {adding ? "Cancel" : "New goal"}
          </button>
        )}
      </div>

      {adding && (
        <form id="ld-goal-form" className="ld-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="ld-field grow">
            <span>Goal</span>
            <input className="ld-input" value={title} maxLength={200} autoFocus placeholder="Ship PKCE login before Friday’s release" onChange={(e) => setTitle(e.target.value)} />
          </label>
          {viewer.admin && canMine && (
            <label className="ld-field">
              <span>For</span>
              <select className="ld-input" value={sc} onChange={(e) => setScope(e.target.value as GoalScope)}>
                <option value="team">The whole team</option>
                <option value="individual">Just me</option>
              </select>
            </label>
          )}
          <div className="ld-form-foot">
            <span className="ld-hint">{sc === "team" ? "A team goal everyone’s agent works toward." : "Your own goal. Only you can edit it."}</span>
            <button type="submit" className="ld-primary" disabled={busy || !title.trim()}>Add goal</button>
          </div>
        </form>
      )}
      {err && <p className="ld-err" role="alert">{err}</p>}

      {team.length === 0 ? (
        <p className="ld-empty">
          {viewer.admin ? "No team goal yet. Add the one thing the whole team is pushing toward." : "No team goal yet. Owners and admins set it."}
        </p>
      ) : (
        team.map((g) => <GoalBlock key={g.id} g={g} team editable={viewer.admin} busy={busy} run={run} owner="Team goal" />)
      )}

      <div className="ld-indiv">
        <h3 className="ld-sub-h">Individual goals</h3>
        {mine.length + others.length === 0 ? (
          <p className="ld-hint">
            No individual goals yet.
            {canMine ? " Add one of your own with New goal." : <> <Link href="/settings">Set your agent identity</Link> to add your own.</>}
          </p>
        ) : (
          <>
            {mine.map((g) => <GoalBlock key={g.id} g={g} editable busy={busy} run={run} owner="Yours" parent={titleOf(g.parentId)} />)}
            {others.map((g) => <GoalBlock key={g.id} g={g} editable={false} busy={busy} run={run} owner={g.member ? nameOf(g.member) : "Someone"} parent={titleOf(g.parentId)} />)}
          </>
        )}
      </div>
    </section>
  );
}

function GoalBlock({
  g, team, editable, busy, run, owner, parent,
}: {
  g: Goal;
  team?: boolean;
  editable: boolean;
  busy: boolean;
  run: (p: Promise<unknown>, after?: () => void) => void;
  owner: string;
  parent?: string;
}) {
  const [step, setStep] = useState("");
  const p = team ? g.rollup : g.progress;
  const linked = team ? g.rollup.total - g.progress.total : 0;
  const addStep = () => {
    const t = step.trim();
    if (!t || busy) return;
    run(api.addGoalItem(g.id, t), () => setStep(""));
  };
  return (
    <article className={`ld-goal ${g.status}${team ? " team" : ""}`} aria-label={`${owner}: ${g.title}`}>
      <div className="ld-goal-top">
        {team && <Ring p={p} />}
        <div className="ld-goal-head">
          <span className="ld-goal-kind">
            {owner} · {g.status === "blocked" ? <span className="rz-chip blocked ld-blocked">blocked</span> : STATUS_LABEL[g.status]}
            {!team && p.total > 0 && ` · ${p.done}/${p.total}`}
          </span>
          <h3 className="ld-goal-title">{g.title}</h3>
          {parent && <span className="ld-hint">toward “{parent}”</span>}
          {linked > 0 && <span className="ld-hint">includes {linked} step{linked > 1 ? "s" : ""} from linked individual goals</span>}
        </div>
      </div>
      {!team && p.total > 0 && <div className="ld-bar" aria-hidden="true"><i style={{ width: `${p.pct}%` }} /></div>}

      {g.items.length > 0 && (
        <ul className="ld-items">
          {g.items.map((it) => (
            <li className={`ld-item${it.done ? " done" : ""}`} key={it.id}>
              <label className="ld-check">
                <input
                  type="checkbox"
                  checked={it.done}
                  disabled={!editable || busy}
                  onChange={() => run(api.patchGoalItem(it.id, { done: !it.done }))}
                />
                <span className="ld-box" aria-hidden="true">✓</span>
                <span className="ld-item-text">{it.text}</span>
              </label>
              {it.origin === "auto" && <span className="ld-item-meta" title={it.evidence || undefined}>from activity</span>}
              {editable && (
                <button type="button" className="ld-x" disabled={busy} onClick={() => run(api.deleteGoalItem(it.id))}>
                  <span aria-hidden="true">×</span><span className="ld-sr">Remove step “{it.text}”</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {g.items.length === 0 && !editable && <p className="ld-hint">No steps yet.</p>}

      {editable && (
        <div className="ld-goal-foot">
          <form className="ld-addstep" onSubmit={(e) => { e.preventDefault(); addStep(); }}>
            <label className="ld-sr" htmlFor={`ld-step-${g.id}`}>Add a step to {g.title}</label>
            <input id={`ld-step-${g.id}`} className="ld-input" value={step} maxLength={300} placeholder="Add a step…" onChange={(e) => setStep(e.target.value)} />
            <button type="submit" className="ld-ghost" disabled={busy || !step.trim()}>Add</button>
          </form>
          <div className="ld-goal-acts">
            <button type="button" className="ld-link" disabled={busy} onClick={() => run(api.patchGoal(g.id, { blocked: !g.blocked }))}>
              {g.blocked ? "Unblock" : "Mark blocked"}
            </button>
            <button type="button" className="ld-link" disabled={busy} onClick={() => { if (confirm(`Delete “${g.title}” and its steps?`)) run(api.deleteGoal(g.id)); }}>
              Delete goal
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function proposalCopy(p: GoalProposal): { title: string; accept: string } {
  if (p.kind === "check_item") return { title: `Mark done: ${p.itemText ?? "a step"}`, accept: "Mark done" };
  if (p.kind === "add_item") return { title: `Add step: ${p.text ?? ""}`, accept: "Add to goal" };
  return { title: `Mark “${p.goalTitle}” blocked`, accept: "Mark blocked" };
}

/**
 * What the pipeline noticed in activity, for the goal's owner to confirm or
 * dismiss. The server only returns proposals this viewer can act on.
 */
export function Proposals({ proposals, admin, nameOf, onChange }: { proposals: GoalProposal[]; admin: boolean; nameOf: (id: string) => string; onChange: () => void }) {
  const { err, busy, run } = useRun(onChange);
  const [last, setLast] = useState("");
  const act = (p: GoalProposal, accept: boolean) => {
    const { title } = proposalCopy(p);
    setLast("");
    run(accept ? api.acceptProposal(p.id) : api.dismissProposal(p.id), () => setLast(`${accept ? "Confirmed" : "Dismissed"}: ${title}`));
  };
  return (
    <section className="ld-card" aria-labelledby="ld-props-h">
      <div className="ld-card-h">
        <h2 id="ld-props-h">Proposed from activity</h2>
        <span className="ld-card-sub">{admin ? "Reins noticed these; you decide" : "For your own goals; you decide"}</span>
      </div>
      {err && <p className="ld-err" role="alert">{err}</p>}
      {proposals.length === 0 ? (
        <p className="ld-empty">Nothing new to propose. Reins checks again as the team works.</p>
      ) : (
        proposals.map((p) => {
          const c = proposalCopy(p);
          return (
            <article className="ld-prop" key={p.id}>
              <span className="ld-prop-title">{c.title}</span>
              <span className="ld-prop-why">
                {p.reason}{p.member ? ` · ${nameOf(p.member)}` : ""}{p.kind !== "block_goal" ? ` · in “${p.goalTitle}”` : ""}
              </span>
              <div className="ld-prop-acts">
                <button type="button" className="ld-primary" disabled={busy} onClick={() => act(p, true)}>{c.accept}</button>
                <button type="button" className="ld-ghost" disabled={busy} onClick={() => act(p, false)}>Dismiss</button>
              </div>
            </article>
          );
        })
      )}
      <p role="status" className="ld-last">{last}</p>
    </section>
  );
}
