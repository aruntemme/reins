"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, type Me } from "@/lib/api";
import "./project-create.css";

// Project ids are used in URLs and the hook config, so keep them to a safe slug.
function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Where the new project's ingest token is handed to the connect page. sessionStorage
 * keeps the secret out of the URL and scoped to this tab.
 */
export const connectKey = (projectId: string) => `reins:connect:${projectId}`;
export interface ConnectHandoff { ingest: string | null; mintErr?: string }

/**
 * "New project" flow for the dashboard: creates the project, then (for owners/
 * admins, who may mint tokens) mints an ingest token so the first agent can
 * connect, and sends the creator to the project's connect page.
 */
export function ProjectCreate({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  // Tracks whether the user has hand-edited the id so we stop auto-deriving it from the name.
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => { api.me().then(setMe).catch(() => {}); }, []);

  // Minting needs owner/admin (or the auth-off local instance). If me() is
  // unknown, try anyway: a refused mint is reported on the connect page.
  const canMint = !me || !me.auth || !!me.admin;

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
    // The project exists now; a failed mint must not read as a failed create.
    const handoff: ConnectHandoff = { ingest: null };
    if (canMint) {
      // Mint an ingest token so the creator can immediately connect an agent.
      // access:false because the dashboard is reached through the logged-in account, not a token.
      try { handoff.ingest = (await api.invite(name.trim() || projectId, false)).ingest; }
      catch (e) { handoff.mintErr = errorMessage(e); }
    }
    try { sessionStorage.setItem(connectKey(projectId), JSON.stringify(handoff)); } catch { /* private mode: the page offers a new token */ }
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
              Pick a display name and an id (used in URLs and the agent hook config).
              {canMint && " We will mint an ingest token so your first agent can connect."}
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
