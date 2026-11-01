"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api";
import "./project-create.css";

// Project ids are used in URLs and the hook config, so keep them to a safe slug.
function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * "New project" flow for the dashboard: creates the project and sends the
 * creator to its connect page, where one command sets up their agents.
 */
export function ProjectCreate({ onCreated, startOpen }: { onCreated?: () => void; startOpen?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A brand-new owner arrives from signup with the dialog already open.
  useEffect(() => { if (startOpen) setOpen(true); }, [startOpen]);
  const [id, setId] = useState("");
  // Tracks whether the user has hand-edited the id so we stop auto-deriving it from the name.
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setId(""); setName(""); setIdTouched(false); setErr("");
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // close only resets local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  const setNameAndId = (value: string) => {
    setName(value);
    // Keep the id mirroring the name until the user edits the id directly.
    if (!idTouched) setId(slug(value));
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const projectId = slug(id);
    if (!projectId) { setErr("Enter a project id (letters, numbers, dashes)."); return; }
    setErr(""); setBusy(true);
    try {
      await api.createProject(projectId, name.trim() || projectId);
    } catch (e) {
      setErr(`Could not create the project: ${errorMessage(e)}`);
      setBusy(false);
      return;
    }
    onCreated?.();
    router.push(`/project/${encodeURIComponent(projectId)}/connect`);
  };

  return (
    <>
      <button ref={trigger} type="button" className="rz-btn primary" onClick={() => setOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        New project
      </button>
      {open && (
        <div className="pc-backdrop" onClick={() => { if (!busy) close(); }}>
          <form
            className="pc-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pc-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={create}
            noValidate
          >
            <p className="rz-eyebrow">New project</p>
            <h2 id="pc-title" className="pc-title">Create a project</h2>
            <p className="pc-sub">
              Pick a display name and an id (used in URLs and the agent hook config). Next you get one command to connect your agents.
            </p>
            <div className="pc-field">
              <label htmlFor="pc-name">Display name</label>
              <input id="pc-name" className="pc-input" placeholder="e.g. Checkout Revamp" value={name} onChange={(e) => setNameAndId(e.target.value)} autoFocus spellCheck={false} autoComplete="off" />
            </div>
            <div className="pc-field">
              <label htmlFor="pc-id">Project id</label>
              <input id="pc-id" className="pc-input mono" placeholder="e.g. checkout-revamp" value={id} onChange={(e) => { setIdTouched(true); setId(e.target.value); }} spellCheck={false} autoComplete="off" />
            </div>
            {err && <p className="pc-err" role="alert">{err}</p>}
            <div className="pc-actions">
              <button type="button" className="rz-btn ghost" onClick={close} disabled={busy}>Cancel</button>
              <button className="rz-btn primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
