"use client";
import { useEffect, useState } from "react";
import { api, type Goal, type GoalProposal } from "@/lib/api";

/**
 * Short-term goals pane: common TEAM goals (admin-managed) and per-person goals,
 * each a checklist with derived progress. Lives in the project's side rail as a
 * vertical pane. Controlled: the page owns the goals fetch (so a small header
 * reference can share it) and passes `onChange` to re-load after a mutation.
 */
/** Small inline reference in the page header that opens the goals panel. */
export function GoalsRef({ goals, proposals, onOpen }: { goals: Goal[]; proposals: GoalProposal[]; onOpen: () => void }) {
  const n = (s: string) => goals.filter((g) => g.status === s).length;
  const done = n("done"), prog = n("in_progress"), blocked = n("blocked"), todo = n("todo");
  return (
    <button className="goals-ref" onClick={onOpen}>
      <span className="mono">short-term goals</span>
      {goals.length === 0 ? (
        <span className="goals-ref-none">none yet</span>
      ) : (
        <>
          <span><b>{done}</b> done</span>
          <span><b>{prog}</b> in progress</span>
          {blocked > 0 && <span className="warn"><b>{blocked}</b> blocked</span>}
          <span><b>{todo}</b> to do</span>
        </>
      )}
      {proposals.length > 0 && <span className="goals-ref-sugg">{proposals.length} suggested</span>}
      <span className="goals-ref-go">open ›</span>
    </button>
  );
}

/** The 'suggested by activity' strip: pipeline proposals the owner confirms/dismisses. */
function ProposalStrip({ proposals, onChange }: { proposals: GoalProposal[]; onChange: () => void }) {
  if (!proposals.length) return null;
  return (
    <div className="goal-props">
      <div className="goal-props-h"><span className="sq active" /> suggested by activity <span className="mono">{proposals.length}</span></div>
      {proposals.map((p) => (
        <div className="goal-prop" key={p.id}>
          <div className="goal-prop-what">
            {p.kind === "check_item" && <><b>mark done?</b> {p.itemText} <span className="goal-owner mono">· {p.goalTitle}</span></>}
            {p.kind === "add_item" && <><b>add step?</b> {p.text} <span className="goal-owner mono">· {p.goalTitle}</span></>}
            {p.kind === "block_goal" && <><b>blocked?</b> <span className="goal-owner mono">{p.goalTitle}</span></>}
          </div>
          <div className="goal-prop-why">{p.reason}{p.member ? ` · ${p.member}` : ""}</div>
          <div className="goal-prop-acts">
            <button className="tiny solid" onClick={() => api.acceptProposal(p.id).then(onChange)}>confirm</button>
            <button className="tiny" onClick={() => api.dismissProposal(p.id).then(onChange)}>dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A slide-in side panel that holds the full goals pane, separate from the board. */
export function GoalsDrawer({
  open, onClose, projectId, goals, proposals, viewer, onChange,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  goals: Goal[];
  proposals: GoalProposal[];
  viewer: { admin: boolean; me: string };
  onChange: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  return (
    <div className={`goals-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="goals-drawer-scrim" onClick={onClose} />
      <aside className="goals-drawer-panel" role="dialog" aria-label="Short-term goals">
        <div className="goals-drawer-head">
          <span className="label"><span className="sq blue" /> short-term goals</span>
          <button className="tiny" onClick={onClose}>close ✕</button>
        </div>
        <div className="goals-drawer-body">
          <GoalsPane projectId={projectId} goals={goals} proposals={proposals} viewer={viewer} onChange={onChange} embedded />
        </div>
      </aside>
    </div>
  );
}

export function GoalsPane({ projectId, goals, proposals, viewer, onChange, embedded }: { projectId: string; goals: Goal[]; proposals: GoalProposal[]; viewer: { admin: boolean; me: string }; onChange: () => void; embedded?: boolean }) {
  const admin = viewer.admin;
  const [me, setMe] = useState(viewer.me);
  useEffect(() => { if (viewer.me) setMe(viewer.me); }, [viewer.me]);

  const team = goals.filter((g) => g.scope === "team");
  const mine = goals.filter((g) => g.scope === "individual" && me && g.member === me);
  const others = goals.filter((g) => g.scope === "individual" && (!me || g.member !== me));

  const ensureMe = (): string => {
    if (me) return me;
    const v = (prompt("Your name (the identity your agent reports as):") || "").trim();
    if (v) { localStorage.setItem("reins-me", v); setMe(v); }
    return v || "me";
  };
  const load = onChange;

  return (
    <div className={embedded ? "goals goals-embedded" : "goals card pad"} id={embedded ? undefined : "goals"}>
      {!embedded && <div className="label" style={{ marginBottom: 14 }}><span className="sq blue" /> short-term goals</div>}

      <ProposalStrip proposals={proposals} onChange={onChange} />

      <Section
        title="Team goals"
        count={team.length}
        canAdd={admin}
        onAdd={(t) => api.addGoal(projectId, { scope: "team", title: t }).then(load)}
        empty={admin ? "Add the common goals the team is working toward." : "No common goals yet."}
      >
        {team.map((g) => <GoalCard key={g.id} g={g} editable={admin} onChange={load} />)}
      </Section>

      <Section
        title="Individual goals"
        count={mine.length + others.length}
        canAdd
        onAdd={(t) => api.addGoal(projectId, { scope: "individual", member: ensureMe(), title: t }).then(load)}
        empty="Add a goal or two of your own."
      >
        {mine.map((g) => <GoalCard key={g.id} g={g} editable mine onChange={load} showMember />)}
        {others.map((g) => <GoalCard key={g.id} g={g} editable={false} onChange={load} showMember />)}
      </Section>
    </div>
  );
}

function Section({
  title, count, canAdd, onAdd, empty, children,
}: {
  title: string;
  count: number;
  canAdd: boolean;
  onAdd?: (title: string) => void;
  empty: string;
  children?: React.ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const submit = () => {
    const t = draft.trim();
    if (!t || !onAdd) return;
    onAdd(t);
    setDraft("");
    setAdding(false);
  };
  return (
    <div className="goal-sec">
      <div className="goal-sec-h">
        <span className="mono">{title}</span>
        {canAdd && (
          <button className="tiny" onClick={() => setAdding((a) => !a)}>{adding ? "cancel" : "+ goal"}</button>
        )}
      </div>
      {adding && (
        <div className="goal-add">
          <input
            value={draft}
            autoFocus
            placeholder="A short-term goal…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <button className="tiny solid" onClick={submit}>add</button>
        </div>
      )}
      {count === 0 ? (empty ? <div className="empty small">{empty}</div> : null) : children}
    </div>
  );
}

function GoalCard({
  g, editable, onChange, showMember, mine,
}: {
  g: Goal;
  editable: boolean;
  onChange: () => void;
  showMember?: boolean;
  mine?: boolean;
}) {
  const [newItem, setNewItem] = useState("");
  const p = g.scope === "team" ? g.rollup : g.progress;
  const addItem = () => {
    const t = newItem.trim();
    if (!t) return;
    api.addGoalItem(g.id, t).then(onChange);
    setNewItem("");
  };
  return (
    <div className={`goal-card ${g.status}`}>
      <div className="goal-top">
        <span className={`goal-dot ${g.status}`} title={g.status} />
        <div className="goal-title">
          {g.title}
          {showMember && g.member ? <span className="goal-owner mono"> · {mine ? "you" : g.member}</span> : null}
        </div>
        <span className="goal-pct mono">{p.done}/{p.total}</span>
      </div>
      <div className="goal-bar"><i style={{ width: `${p.pct}%` }} /></div>
      {g.items.length > 0 && (
        <div className="goal-items">
          {g.items.map((it) => (
            <label className={`goal-item ${it.done ? "done" : ""}`} key={it.id}>
              <input
                type="checkbox"
                checked={it.done}
                disabled={!editable}
                onChange={() => api.patchGoalItem(it.id, { done: !it.done }).then(onChange)}
              />
              <span>{it.text}</span>
              {editable && (
                <button className="goal-x" title="remove" onClick={() => api.deleteGoalItem(it.id).then(onChange)}>×</button>
              )}
            </label>
          ))}
        </div>
      )}
      {editable && (
        <div className="goal-additem">
          <input
            value={newItem}
            placeholder="add a step…"
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addItem(); }}
          />
        </div>
      )}
      {editable && (
        <div className="goal-acts">
          <button className="tiny" onClick={() => api.patchGoal(g.id, { blocked: !g.blocked }).then(onChange)}>
            {g.blocked ? "unblock" : "block"}
          </button>
          <button className="tiny" onClick={() => { if (confirm("Delete this goal?")) api.deleteGoal(g.id).then(onChange); }}>
            delete
          </button>
        </div>
      )}
    </div>
  );
}
