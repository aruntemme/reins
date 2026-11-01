"use client";
import { useState } from "react";
import { api, errorMessage, timeAgo, type Project, type Handoff, type Member } from "@/lib/api";
import { handleAuth } from "@/lib/guard";

const EXPIRY: { label: string; hours: number }[] = [
  { label: "4 hours", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
];

function untilLabel(ts: number): string {
  const h = Math.max(0, (ts - Date.now()) / 3_600_000);
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m left` : h < 48 ? `${Math.round(h)}h left` : `${Math.round(h / 24)}d left`;
}

/**
 * Lead directives and assignments, in the rail. Everyone sees what's active (a
 * directive is never hidden from the people it targets); owners/admins also get
 * the compose form and the clear buttons.
 */
export function LeadPanel({ proj, admin, onChange }: { proj: Project; admin: boolean; onChange: () => void }) {
  const [text, setText] = useState("");
  const [targets, setTargets] = useState<string[]>([]); // [] = whole team
  const [hours, setHours] = useState(24);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => proj.members.find((m) => m.member === id)?.displayName || id;

  if (!admin && proj.directives.length === 0 && proj.assignments.length === 0) return null;

  const run = async (p: Promise<unknown>, after?: () => void) => {
    setErr("");
    setBusy(true);
    try {
      await p;
      after?.();
      onChange();
    } catch (e) {
      if (!handleAuth(e)) setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const post = () => {
    if (!text.trim()) return;
    run(api.postDirective(proj.id, { text: text.trim(), targets, ttlHours: hours }), () => { setText(""); setTargets([]); });
  };

  return (
    <div className="card lead">
      <div className="label"><span className="sq blue" /> from the lead</div>
      {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}

      {proj.directives.length === 0 && proj.assignments.length === 0 && (
        <div className="empty">No directives or assignments. Posted ones reach the targeted agents on their next turn.</div>
      )}
      {proj.directives.map((d) => (
        <div className="litem" key={d.id}>
          <div className="ltext">{d.text}</div>
          <div className="lmeta">
            <span className="mono">
              to {d.targets.length ? d.targets.map(nameOf).join(", ") : "whole team"} · {untilLabel(d.expiresAt)}
              {d.by ? ` · ${d.by}` : ""}
            </span>
            {admin && <button className="tiny" disabled={busy} onClick={() => run(api.clearDirective(d.id, proj.id))}>clear</button>}
          </div>
        </div>
      ))}
      {proj.assignments.map((a) => (
        <div className="litem" key={a.id}>
          <div className="ltext"><span className="mono lkind">assigned</span> {a.area} → <strong>{nameOf(a.member)}</strong></div>
          <div className="lmeta">
            <span className="mono">{a.note ? `${a.note} · ` : ""}{timeAgo(a.createdAt)}{a.by ? ` · ${a.by}` : ""}</span>
            {admin && <button className="tiny" disabled={busy} onClick={() => run(api.clearAssignment(a.id, proj.id))}>clear</button>}
          </div>
        </div>
      ))}

      {admin && proj.members.length > 0 && (
        <div className="lcompose">
          <textarea
            rows={2}
            value={text}
            placeholder="Post a directive, e.g. “Freeze schema changes until the migration lands.”"
            onChange={(e) => setText(e.target.value)}
            aria-label="Directive text"
          />
          <div className="ltargets" role="group" aria-label="Who it's for">
            <button className={`fchip${targets.length === 0 ? " on" : ""}`} onClick={() => setTargets([])}>whole team</button>
            {proj.members.map((m) => (
              <button key={m.member} className={`fchip${targets.includes(m.member) ? " on" : ""}`} onClick={() => toggle(m.member)}>
                {m.displayName}
              </button>
            ))}
          </div>
          <div className="lrow">
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Expires after">
              {EXPIRY.map((x) => <option key={x.hours} value={x.hours}>expires in {x.label}</option>)}
            </select>
            <button className="btn solid" disabled={busy || !text.trim()} onClick={post}>Post</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline "assign this area" form, opened from a collision or risk on the board.
 * Creates a directed handoff to the assignee plus an advisory claim that the
 * pre-edit check warns everyone else about.
 */
export function AssignForm({
  proj, area, suggested, onDone, onCancel,
}: { proj: Project; area: string; suggested: string[]; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState(area);
  const [member, setMember] = useState(suggested[0] ?? proj.members[0]?.member ?? "");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const ordered = [
    ...proj.members.filter((m) => suggested.includes(m.member)),
    ...proj.members.filter((m) => !suggested.includes(m.member)),
  ];
  const save = async () => {
    setErr("");
    try {
      await api.assign(proj.id, { area: value.trim(), member, note: note.trim() || undefined });
    } catch (e) {
      if (!handleAuth(e)) setErr(errorMessage(e));
      return;
    }
    onDone();
  };
  return (
    <div className="assignform">
      <div className="label"><span className="sq blue" /> assign an owner</div>
      <input className="tokeninput" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Area (file path or free text)" />
      <div className="lrow">
        <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Assign to">
          {ordered.map((m) => <option key={m.member} value={m.member}>{m.displayName}</option>)}
        </select>
        <input className="tokeninput" style={{ flex: 1, minWidth: 0 }} value={note} placeholder="note (optional)" onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      </div>
      <div className="lrow">
        <button className="btn solid" disabled={!value.trim() || !member} onClick={save}>Assign</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
      <div className="mono" style={{ fontSize: 11 }}>Advisory: anyone else’s agent is warned before editing it. Nothing is blocked.</div>
    </div>
  );
}

/** Handoffs Reins closed on its own, each with the reason and a one-click reopen. */
export function AutoClosedList({ items, projectId, act }: { items: Handoff[]; projectId: string; act: (p: Promise<unknown>) => void }) {
  if (!items.length) return null;
  return (
    <div className="autoclosed">
      {items.map((h) => (
        <div className="acrow" key={h.id} title={h.text}>
          <span className="mono ackind">{h.kind}{h.from ? ` · ${h.from}` : ""}</span>
          <span className="actext">auto-closed: {h.autoClosed?.reason || "no longer applies"}</span>
          <button className="tiny" onClick={() => act(api.handoff(h.id, projectId, "reopen"))}>reopen</button>
        </div>
      ))}
    </div>
  );
}

/** "⎇ feat/x · 3 uncommitted" — or just the dirty count when branches are hidden. */
export function gitLabel(m: Pick<Member, "git">): string {
  if (!m.git) return "";
  const parts: string[] = [];
  if (m.git.branch) parts.push(`⎇ ${m.git.branch}`);
  if (m.git.dirty) parts.push(`${m.git.dirty} uncommitted`);
  return parts.join(" · ");
}
