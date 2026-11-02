"use client";
import { useEffect, useId, useRef, useState } from "react";
import { api, type ItemData, type ItemKind, type ItemStatus, type Who } from "@/lib/api";
import { useAction } from "./shell";
import { KINDS, KIND_LABEL } from "./format";

/** A native modal dialog: focus is trapped, Escape and a backdrop click close it. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const hid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="w-dialog"
      aria-labelledby={hid}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <div className="w-dialog-in">
          <div className="w-dialog-h">
            <h2 id={hid}>{title}</h2>
            <button type="button" className="w-iconbtn" onClick={onClose} aria-label="Close">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Two people can share a display name: label those "Dev (alice)", as the board does. */
function distinctNames(list: Who[]): Who[] {
  const count = new Map<string, number>();
  for (const w of list) count.set(w.displayName.toLowerCase(), (count.get(w.displayName.toLowerCase()) ?? 0) + 1);
  return list.map((w) =>
    (count.get(w.displayName.toLowerCase()) ?? 0) > 1 && w.displayName !== w.member
      ? { ...w, displayName: `${w.displayName} (${w.member.split("@")[0]})` }
      : w,
  );
}

/** The project's people (anyone whose agent has checked in), loaded when a dialog opens. */
function useMembers(projectId: string, open: boolean, ensure: (string | undefined | null)[] = []): Who[] | null {
  const [list, setList] = useState<Who[] | null>(null);
  useEffect(() => {
    if (!open || list) return;
    api.project(projectId)
      .then((p) => setList(distinctNames(p.members.map((m) => ({ member: m.member, displayName: m.displayName || m.member })))))
      .catch(() => setList([]));
  }, [open, projectId, list]);
  if (!list) return null;
  const extra = ensure.filter((m): m is string => !!m && !list.some((w) => w.member === m)).map((m) => ({ member: m, displayName: m }));
  return [...list, ...extra];
}

function KindPicker({ value, onChange }: { value: ItemKind; onChange: (k: ItemKind) => void }) {
  const name = useId();
  return (
    <fieldset className="w-field w-kinds">
      <legend>Kind</legend>
      <div className="w-seg">
        {KINDS.map((k) => (
          <label key={k} className={value === k ? "on" : ""}>
            <input type="radio" name={name} value={k} checked={value === k} onChange={() => onChange(k)} />
            {KIND_LABEL[k]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PersonSelect({ id, label, value, onChange, people, empty }: { id: string; label: string; value: string; onChange: (v: string) => void; people: Who[] | null; empty?: string }) {
  return (
    <div className="w-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={!people}>
        {empty !== undefined && <option value="">{empty}</option>}
        {!people && <option value="">Loading people…</option>}
        {people?.map((p) => <option key={p.member} value={p.member}>{p.displayName}</option>)}
      </select>
    </div>
  );
}

function Actions({ busy, submit, err, onClose, extra }: { busy: boolean; submit: string; err: string; onClose: () => void; extra?: React.ReactNode }) {
  return (
    <>
      {err && <p className="w-err" role="alert">{err}</p>}
      <div className="w-dialog-acts">
        {extra}
        <button type="button" className="w-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="w-btn strong" disabled={busy}>{busy ? "Saving…" : submit}</button>
      </div>
    </>
  );
}

/** New item: title, kind, owner, optional release, steps, branch. */
export function NewItemDialog({
  projectId, open, onClose, onDone, me, owner, release,
}: {
  projectId: string; open: boolean; onClose: () => void; onDone: () => void;
  me?: string | null; owner?: string | null; release: { id: string; title: string } | null;
}) {
  const uid = useId();
  const people = useMembers(projectId, open, [me, owner]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ItemKind>("feature");
  const [who, setWho] = useState(owner || me || "");
  const [rel, setRel] = useState("");
  const [steps, setSteps] = useState("");
  const [branch, setBranch] = useState("");
  const { busy, err, run, setErr } = useAction(onDone);
  useEffect(() => {
    if (open) { setTitle(""); setKind("feature"); setWho(owner || me || ""); setRel(""); setSteps(""); setBranch(""); setErr(""); }
  }, [open, owner, me, setErr]);

  const submit = async () => {
    if (!title.trim()) { setErr("Give it a title."); return; }
    const list = steps.split("\n").map((s) => s.trim()).filter(Boolean);
    const ok = await run(() => api.createItem(projectId, {
      title: title.trim(), kind,
      ...(who ? { owner: who } : {}),
      ...(rel ? { releaseId: rel } : {}),
      ...(list.length ? { steps: list } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    }));
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="New item">
      <form className="w-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="w-field">
          <label htmlFor={`${uid}-t`}>Title</label>
          <input id={`${uid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Refunds, or Webcam drops on a bad network" maxLength={200} autoFocus required />
        </div>
        <KindPicker value={kind} onChange={setKind} />
        <PersonSelect id={`${uid}-o`} label="Owner" value={who} onChange={setWho} people={people} />
        {release && (
          <div className="w-field">
            <label htmlFor={`${uid}-r`}>Release <span className="w-quiet">optional</span></label>
            <select id={`${uid}-r`} value={rel} onChange={(e) => setRel(e.target.value)}>
              <option value="">Not in a release</option>
              <option value={release.id}>{release.title}</option>
            </select>
          </div>
        )}
        <div className="w-field">
          <label htmlFor={`${uid}-s`}>Steps <span className="w-quiet">optional, one per line</span></label>
          <textarea id={`${uid}-s`} rows={4} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={"Verify the signature\nIdempotency on event id"} />
        </div>
        <div className="w-field">
          <label htmlFor={`${uid}-b`}>Branch <span className="w-quiet">optional</span></label>
          <input id={`${uid}-b`} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/refund-webhook" className="w-mono" maxLength={200} />
          <span className="w-hint">Agent sessions on this branch attach to it on their own.</span>
        </div>
        <Actions busy={busy} submit="Create item" err={err} onClose={onClose} />
      </form>
    </Dialog>
  );
}

const toInput = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fromInput = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};

/** Plan, rename, re-date or remove the release. Optional: most work is simply owned. */
export function ReleaseDialog({
  projectId, open, onClose, onDone, release,
}: {
  projectId: string; open: boolean; onClose: () => void; onDone: () => void;
  release: { id: string; title: string; dueAt: number | null } | null;
}) {
  const uid = useId();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [sure, setSure] = useState(false);
  const { busy, err, run, setErr } = useAction(onDone);
  // Reset only when the dialog opens: the page refetches live and must not wipe what is being typed.
  const rel = useRef(release);
  rel.current = release;
  useEffect(() => {
    const r = rel.current;
    if (open) { setTitle(r?.title || ""); setDue(r?.dueAt ? toInput(r.dueAt) : ""); setSure(false); setErr(""); }
  }, [open, setErr]);

  const submit = async () => {
    if (!title.trim()) { setErr("Give the release a name."); return; }
    const body = { title: title.trim(), dueAt: due ? fromInput(due) : null };
    const ok = await run(() => (release ? api.patchRelease(release.id, body) : api.createRelease(projectId, body)));
    if (ok) onClose();
  };
  const remove = async () => {
    if (!release) return;
    if (!sure) { setSure(true); return; }
    if (await run(() => api.deleteRelease(release.id))) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={release ? "Edit release" : "Plan a release"}>
      <form className="w-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="w-quiet">A shared target some items roll into. Owned work doesn’t need one.</p>
        <div className="w-field">
          <label htmlFor={`${uid}-t`}>Name</label>
          <input id={`${uid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="v2.4" maxLength={120} autoFocus required />
        </div>
        <div className="w-field">
          <label htmlFor={`${uid}-d`}>Due <span className="w-quiet">optional</span></label>
          <input id={`${uid}-d`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <Actions
          busy={busy}
          submit={release ? "Save" : "Plan release"}
          err={err}
          onClose={onClose}
          extra={release ? (
            <button type="button" className="w-btn danger w-push" onClick={remove} disabled={busy}>
              {sure ? "Remove it? Items stay" : "Remove release"}
            </button>
          ) : null}
        />
      </form>
    </Dialog>
  );
}

/** A note to the whole team or one person; their agents read it at the next prompt. */
export function WriteDialog({
  projectId, open, onClose, onDone, onSent, to, me,
}: {
  projectId: string; open: boolean; onClose: () => void; onDone: () => void;
  /** Called with who it went to ("the team" or a name), for a confirmation on the page. */
  onSent?: (to: string) => void;
  to?: string | null; me?: string | null;
}) {
  const uid = useId();
  const people = useMembers(projectId, open, [to]);
  const [who, setWho] = useState(to || "");
  const [text, setText] = useState("");
  const { busy, err, run, setErr } = useAction(onDone);
  useEffect(() => { if (open) { setWho(to || ""); setText(""); setErr(""); } }, [open, to, setErr]);

  const submit = async () => {
    if (!text.trim()) { setErr("Write something first."); return; }
    const ok = await run(() => api.createPost(projectId, { kind: "note", text: text.trim(), ...(who ? { toMember: who } : {}) }));
    if (ok) {
      onSent?.(who ? people?.find((p) => p.member === who)?.displayName || who : "the team");
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Write to the team">
      <form className="w-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <PersonSelect id={`${uid}-to`} label="To" value={who} onChange={setWho} people={people?.filter((p) => p.member !== me) ?? null} empty="The whole team" />
        <div className="w-field">
          <label htmlFor={`${uid}-x`}>Note</label>
          <textarea id={`${uid}-x`} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Please land the webcam fix by Wednesday; v2.4 waits on it." maxLength={2000} autoFocus />
          <span className="w-hint">Their agents read it as background at the next prompt. It never overrides what they were asked to do.</span>
        </div>
        <Actions busy={busy} submit="Send note" err={err} onClose={onClose} />
      </form>
    </Dialog>
  );
}

/** Hand an item to someone else, with an optional note that travels with it. */
export function HandoverDialog({
  projectId, open, onClose, onDone, item, owner,
}: {
  projectId: string; open: boolean; onClose: () => void; onDone: () => void;
  item: { id: string; title: string } | null; owner?: string | null;
}) {
  const uid = useId();
  const people = useMembers(projectId, open);
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const { busy, err, run, setErr } = useAction(onDone);
  useEffect(() => { if (open) { setWho(""); setNote(""); setErr(""); } }, [open, setErr]);
  const options = people?.filter((p) => p.member !== owner) ?? null;

  const submit = async () => {
    if (!item) return;
    if (!who) { setErr("Pick who takes it."); return; }
    const ok = await run(async () => {
      // The owner change itself posts the handover (with the note) on the server.
      await api.patchItem(item.id, { owner: who, ...(note.trim() ? { note: note.trim() } : {}) });
    });
    if (ok) onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title={item ? `Hand over ${item.title}` : "Hand over"}>
      <form className="w-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <PersonSelect id={`${uid}-to`} label="To" value={who} onChange={setWho} people={options} empty="Choose a person" />
        <div className="w-field">
          <label htmlFor={`${uid}-n`}>Note <span className="w-quiet">optional</span></label>
          <textarea id={`${uid}-n`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ledger writes go through billing/ledger.ts…" maxLength={2000} />
          <span className="w-hint">Their agent gets it with the item at its next prompt.</span>
        </div>
        <Actions busy={busy} submit="Hand over" err={err} onClose={onClose} />
      </form>
    </Dialog>
  );
}

const STATUSES: { v: ItemStatus; label: string }[] = [
  { v: "open", label: "Open" },
  { v: "doing", label: "Doing" },
  { v: "waiting", label: "Waiting" },
  { v: "blocked", label: "Blocked" },
  { v: "paused", label: "Paused" },
  { v: "done", label: "Done" },
];

/** Rename, re-kind, set status, branch, or move in or out of the release. */
export function EditItemDialog({
  projectId, open, onClose, onDone, item,
}: {
  projectId: string; open: boolean; onClose: () => void; onDone: () => void; item: ItemData["item"];
}) {
  const uid = useId();
  const [title, setTitle] = useState(item.title);
  const [kind, setKind] = useState<ItemKind>(item.kind);
  const [status, setStatus] = useState<ItemStatus>(item.status);
  const [branch, setBranch] = useState(item.branch || "");
  const [rel, setRel] = useState(item.release?.id || "");
  const [current, setCurrent] = useState<{ id: string; title: string } | null>(null);
  const { busy, err, run, setErr } = useAction(onDone);
  // Reset only when the dialog opens: the page refetches live and must not wipe what is being typed.
  const cur = useRef(item);
  cur.current = item;
  useEffect(() => {
    if (!open) return;
    const it = cur.current;
    setTitle(it.title); setKind(it.kind); setStatus(it.status); setBranch(it.branch || ""); setRel(it.release?.id || ""); setErr("");
    api.today(projectId).then((t) => setCurrent(t.release ? { id: t.release.id, title: t.release.title } : null)).catch(() => {});
  }, [open, projectId, setErr]);

  const releases = [item.release, current].filter((r, i, a): r is { id: string; title: string } => !!r && a.findIndex((x) => x?.id === r.id) === i);
  const submit = async () => {
    if (!title.trim()) { setErr("Give it a title."); return; }
    const ok = await run(() => api.patchItem(item.id, {
      title: title.trim(), kind, status, branch: branch.trim() || null, releaseId: rel || null,
    }));
    if (ok) onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Edit item">
      <form className="w-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="w-field">
          <label htmlFor={`${uid}-t`}>Title</label>
          <input id={`${uid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
        </div>
        <KindPicker value={kind} onChange={setKind} />
        <div className="w-field">
          <label htmlFor={`${uid}-s`}>Status</label>
          <select id={`${uid}-s`} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
            {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </div>
        {releases.length > 0 && (
          <div className="w-field">
            <label htmlFor={`${uid}-r`}>Release</label>
            <select id={`${uid}-r`} value={rel} onChange={(e) => setRel(e.target.value)}>
              <option value="">Not in a release</option>
              {releases.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </div>
        )}
        <div className="w-field">
          <label htmlFor={`${uid}-b`}>Branch</label>
          <input id={`${uid}-b`} value={branch} onChange={(e) => setBranch(e.target.value)} className="w-mono" placeholder="feat/refund-webhook" maxLength={200} />
          <span className="w-hint">Agent sessions on this branch attach to it on their own.</span>
        </div>
        <Actions busy={busy} submit="Save" err={err} onClose={onClose} />
      </form>
    </Dialog>
  );
}
