"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Goal } from "@/lib/api";
import { handleAuth } from "@/lib/guard";

/**
 * Short-term goals pane: common TEAM goals (admin-managed) and per-person goals,
 * each a checklist with derived progress. Sits beneath the project's global goal.
 * Reloads whenever the page's SSE `reload` counter ticks.
 */
export function GoalsPane({ projectId, reload }: { projectId: string; reload: number }) {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [me, setMe] = useState("");

  const load = useCallback(async () => {
    try { setGoals((await api.goals(projectId)).goals); }
    catch (e) { handleAuth(e); }
  }, [projectId]);

  useEffect(() => {
    api.me()
      .then((m) => {
        setAdmin(!!m.admin || !m.auth); // auth-off dev mode = full control
        setMe(m.user?.email || localStorage.getItem("reins-me") || "");
      })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load, reload]);

  if (!goals) return null;

  const team = goals.filter((g) => g.scope === "team");
  const mine = goals.filter((g) => g.scope === "individual" && me && g.member === me);
  const others = goals.filter((g) => g.scope === "individual" && (!me || g.member !== me));

  const ensureMe = (): string => {
    if (me) return me;
    const v = (prompt("Your name (the identity your agent reports as):") || "").trim();
    if (v) { localStorage.setItem("reins-me", v); setMe(v); }
    return v || "me";
  };

  return (
    <div className="goals card pad">
      <div className="label" style={{ marginBottom: 14 }}><span className="sq blue" /> short-term goals</div>

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
        title="My goals"
        count={mine.length}
        canAdd
        onAdd={(t) => api.addGoal(projectId, { scope: "individual", member: ensureMe(), title: t }).then(load)}
        empty="Add a goal or two of your own."
      >
        {mine.map((g) => <GoalCard key={g.id} g={g} editable onChange={load} />)}
      </Section>

      {others.length > 0 && (
        <Section title="Teammates' goals" count={others.length} canAdd={false} empty="">
          {others.map((g) => <GoalCard key={g.id} g={g} editable={false} onChange={load} showMember />)}
        </Section>
      )}
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
  g, editable, onChange, showMember,
}: {
  g: Goal;
  editable: boolean;
  onChange: () => void;
  showMember?: boolean;
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
          {showMember && g.member ? <span className="goal-owner mono"> · {g.member}</span> : null}
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
