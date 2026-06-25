"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { CopyCommand } from "./copy-command";

// Project ids are used in URLs and the hook config, so keep them to a safe slug.
function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * "New project" flow for the dashboard: creates the project, then mints an ingest
 * token so the first agent can connect, and hands back the one-line install command.
 */
export function ProjectCreate({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  // Tracks whether the user has hand-edited the id so we stop auto-deriving it from the name.
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ id: string; ingest: string } | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const setNameAndId = (value: string) => {
    setName(value);
    // Keep the id mirroring the name until the user edits the id directly.
    if (!idTouched) setId(slug(value));
  };

  const create = async () => {
    const projectId = slug(id);
    if (!projectId) { setErr("Enter a project id (letters, numbers, dashes)."); return; }
    setErr(""); setBusy(true);
    try {
      await api.createProject(projectId, name.trim() || projectId);
      // Mint an ingest token so the creator can immediately connect an agent.
      // access:false because the dashboard is reached through the logged-in account, not a token.
      const minted = await api.invite(name.trim() || projectId, false);
      setResult({ id: projectId, ingest: minted.ingest });
      onCreated?.();
    } catch {
      setErr("Could not create the project. The id may already be taken, or you lack permission.");
    }
    setBusy(false);
  };

  const reset = () => {
    setOpen(false); setResult(null);
    setId(""); setName(""); setIdTouched(false); setErr("");
  };

  return (
    <>
      <button className="btn solid" onClick={() => setOpen(true)}>+ new project</button>
      {open && (
        <div className="invite-backdrop" onClick={reset}>
          <div className="invite-modal card pad" onClick={(e) => e.stopPropagation()}>
            {!result ? (
              <>
                <div className="label" style={{ marginBottom: 12 }}><span className="sq blue" /> new project</div>
                <h3 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Create a project</h3>
                <p className="sub" style={{ fontSize: 14, marginBottom: 18 }}>
                  Pick an id (used in URLs and the agent hook config) and a display name.
                  We will mint an ingest token so your first agent can connect.
                </p>
                <label className="invite-l">Display name</label>
                <input
                  className="tokeninput"
                  placeholder="e.g. Checkout Revamp"
                  value={name}
                  onChange={(e) => setNameAndId(e.target.value)}
                  autoFocus
                  spellCheck={false}
                />
                <label className="invite-l" style={{ marginTop: 14 }}>Project id (slug)</label>
                <input
                  className="tokeninput"
                  placeholder="e.g. checkout-revamp"
                  value={id}
                  onChange={(e) => { setIdTouched(true); setId(e.target.value); }}
                  spellCheck={false}
                />
                {err && <div className="mono" style={{ color: "var(--blocked)", marginTop: 12 }}>{err}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button className="btn solid" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create project"}</button>
                  <button className="btn ghost" onClick={reset}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="label" style={{ marginBottom: 12 }}><span className="sq active" /> project ready</div>
                <h3 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Connect your first agent</h3>
                <p className="sub" style={{ fontSize: 13.5, margin: "0 0 8px" }}>
                  Run this in your agent's repo to install the capture hook for <code>{result.id}</code>:
                </p>
                <CopyCommand block text={`npx reins-hook install --url ${origin} --project ${result.id} --token ${result.ingest}`} />
                <p className="sub" style={{ fontSize: 13.5, margin: "16px 0 0" }}>
                  Then run <code>/hooks</code> in Claude Code to approve it.
                </p>
                <p className="mono muted" style={{ marginTop: 14, fontSize: 11.5 }}>
                  This ingest token is shown once. It is workspace-scoped. Revoke any time from settings.
                </p>
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button className="btn ghost" onClick={reset}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
