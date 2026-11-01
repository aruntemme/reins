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

/** Runs one mutation at a time, then reloads; keeps the server's error for display. */
export function useRun(onChange: () => void) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
  return { err, busy, run };
}

/**
 * Who a directive will reach, by liveness. Reins has no delivery receipts: an
 * agent picks a directive up on its next prompt, so this only says who is live.
 */
function Reach({ members }: { members: Member[] }) {
  const live = members.filter((m) => m.live).length;
  const away = members.length - live;
  const text =
    members.length === 0 ? "no agents connected yet"
    : members.length === 1 ? `${members[0]!.displayName} ${live ? "live" : "away"}`
    : away === 0 ? `${live} live`
    : live === 0 ? `${away} away`
    : `${live} live · ${away} away`;
  return (
    <span className="ld-reach">
      {members.slice(0, 12).map((m) => (
        <span key={m.member} className={`ld-pip${m.live ? " on" : ""}`} title={`${m.displayName} · ${m.live ? "live" : "away"}`} aria-hidden="true" />
      ))}
      {members.length > 12 && <span aria-hidden="true">+{members.length - 12}</span>}
      <span>{text}</span>
    </span>
  );
}

/**
 * The sky composer band: post a directive to the whole team or one teammate and
 * see what's in force. Everyone sees active directives (they are never hidden
 * from the people they target); only owners/admins post and clear them.
 */
export function DirectiveBand({ proj, admin, onChange }: { proj: Project; admin: boolean; onChange: () => void }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState(""); // "" = whole team
  const [hours, setHours] = useState(24);
  const [sent, setSent] = useState("");
  const { err, busy, run } = useRun(onChange);
  const byId = new Map(proj.members.map((m) => [m.member, m]));
  const nameOf = (id: string) => byId.get(id)?.displayName || id;
  const reachOf = (targets: string[]) =>
    targets.length ? targets.map((t) => byId.get(t)).filter((m): m is Member => !!m) : proj.members;
  const to = byId.has(target) ? target : "";

  const post = () => {
    const t = text.trim();
    if (!t || busy) return;
    setSent("");
    run(api.postDirective(proj.id, { text: t, targets: to ? [to] : [], ttlHours: hours }), () => {
      setText("");
      setSent(`Sent to ${to ? nameOf(to) : "the whole team"}. Each agent gets it on its next prompt.`);
    });
  };

  return (
    <section className="ld-band rz-field" aria-labelledby="ld-h1">
      <span className="rz-blob" aria-hidden="true" />
      <div className="ld-band-in">
        <div className="ld-band-top">
          <h1 id="ld-h1"><span className="ld-h1-l">Say it once.</span> <span className="ld-h1-l">Every agent hears it.</span></h1>
          <span className="ld-reachnote">Reaches each agent on its next prompt</span>
        </div>

        {admin && (
          <form className="ld-compose rz-glass" onSubmit={(e) => { e.preventDefault(); post(); }}>
            <label className="ld-sr" htmlFor="ld-to">Send to</label>
            <select id="ld-to" className="ld-to" value={to} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Whole team</option>
              {proj.members.map((m) => <option key={m.member} value={m.member}>{m.displayName}</option>)}
            </select>
            <label className="ld-sr" htmlFor="ld-text">Directive</label>
            <input
              id="ld-text"
              className="ld-text"
              type="text"
              maxLength={500}
              autoComplete="off"
              value={text}
              placeholder={`Tell every agent on ${proj.name || proj.id}…`}
              onChange={(e) => setText(e.target.value)}
            />
            <label className="ld-sr" htmlFor="ld-ttl">Expires after</label>
            <select id="ld-ttl" className="ld-ttl" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {EXPIRY.map((x) => <option key={x.hours} value={x.hours}>for {x.label}</option>)}
            </select>
            <button type="submit" className="ld-send" disabled={busy || !text.trim()}>Send to agents</button>
          </form>
        )}
        {!admin && (
          <p className="ld-note">Only workspace owners and admins can send directives. You can see everything in force below.</p>
        )}

        {admin && (
          <div className="ld-band-foot">
            <Reach members={reachOf(to ? [to] : [])} />
            <span role="status" className="ld-sent">{sent}</span>
          </div>
        )}
        {err && <p className="ld-band-err" role="alert">{err}</p>}

        {proj.directives.length === 0 ? (
          <p className="ld-note">
            {admin ? "No directives in force. Anything you send is added to each agent’s context on its next prompt." : "No directives in force right now."}
          </p>
        ) : (
          <ul className="ld-dirs" aria-label="Directives in force">
            {proj.directives.map((d) => (
              <li className="ld-dir" key={d.id}>
                <p className="ld-dir-text">“{d.text}”</p>
                <div className="ld-dir-meta">
                  <span>to {d.targets.length ? d.targets.map(nameOf).join(", ") : "whole team"} · {untilLabel(d.expiresAt)}{d.by ? ` · from ${d.by}` : ""}</span>
                  <Reach members={reachOf(d.targets)} />
                  {admin && (
                    <button type="button" className="ld-clear" disabled={busy} onClick={() => run(api.clearDirective(d.id, proj.id))}>
                      Clear<span className="ld-sr"> directive “{d.text}”</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Area ownership: assigning one sends a directed handoff to the owner and an
 * advisory claim every other agent is warned about before editing. `prefill`
 * opens the form for an area picked elsewhere (e.g. a collision on the lanes).
 */
export function Assignments({
  proj, admin, prefill, onChange,
}: { proj: Project; admin: boolean; prefill?: { area: string; suggested: string[] } | null; onChange: () => void }) {
  const suggested = prefill?.suggested ?? [];
  const ordered = [
    ...proj.members.filter((m) => suggested.includes(m.member)),
    ...proj.members.filter((m) => !suggested.includes(m.member)),
  ];
  const [open, setOpen] = useState(!!prefill?.area);
  const [area, setArea] = useState(prefill?.area ?? "");
  const [member, setMember] = useState(ordered[0]?.member ?? "");
  const [note, setNote] = useState("");
  const { err, busy, run } = useRun(onChange);
  const nameOf = (id: string) => proj.members.find((m) => m.member === id)?.displayName || id;
  const who = proj.members.some((m) => m.member === member) ? member : ordered[0]?.member ?? "";

  const save = () => {
    if (!area.trim() || !who || busy) return;
    run(api.assign(proj.id, { area: area.trim(), member: who, note: note.trim() || undefined }), () => {
      setArea("");
      setNote("");
      setOpen(false);
    });
  };

  return (
    <section className="ld-card" id="assign" aria-labelledby="ld-asg-h">
      <div className="ld-card-h">
        <h2 id="ld-asg-h">Assignments</h2>
        {admin && proj.members.length > 0 && (
          <button type="button" className="ld-ghost" aria-expanded={open} aria-controls="ld-asg-form" onClick={() => setOpen((o) => !o)}>
            {open ? "Cancel" : "Assign an area"}
          </button>
        )}
      </div>

      {admin && open && (
        <form id="ld-asg-form" className="ld-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label className="ld-field grow">
            <span>Area</span>
            <input
              className="ld-input"
              value={area}
              maxLength={200}
              autoFocus
              placeholder="src/auth/** or “the billing migration”"
              onChange={(e) => setArea(e.target.value)}
            />
          </label>
          <label className="ld-field">
            <span>Owner</span>
            <select className="ld-input" value={who} onChange={(e) => setMember(e.target.value)}>
              {ordered.map((m) => <option key={m.member} value={m.member}>{m.displayName}</option>)}
            </select>
          </label>
          <label className="ld-field grow">
            <span>Note (optional)</span>
            <input className="ld-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="ld-form-foot">
            <span className="ld-hint">Advisory: other agents are warned before editing it. Nothing is blocked.</span>
            <button type="submit" className="ld-primary" disabled={busy || !area.trim() || !who}>Assign</button>
          </div>
        </form>
      )}
      {err && <p className="ld-err" role="alert">{err}</p>}

      {proj.assignments.length === 0 ? (
        <p className="ld-empty">
          {admin
            ? proj.members.length
              ? "No areas assigned. Give one an owner and every other agent checks with them before editing it."
              : "No teammates yet. Areas can be assigned once someone’s agent connects."
            : "No areas assigned."}
        </p>
      ) : (
        <ul className="ld-asgs">
          {proj.assignments.map((a) => (
            <li className="ld-asg" key={a.id}>
              <span className="ld-asg-area">{a.area}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" role="img" aria-label="assigned to">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
              <span className="ld-asg-who">{nameOf(a.member)}</span>
              <span className="ld-asg-meta">
                {a.note || "agents check with them first"} · {timeAgo(a.createdAt)}{a.by ? ` · by ${a.by}` : ""}
              </span>
              {admin && (
                <button type="button" className="ld-ghost ld-asg-clear" disabled={busy} onClick={() => run(api.clearAssignment(a.id, proj.id))}>
                  Clear<span className="ld-sr"> assignment of {a.area}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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
