"use client";
import { useEffect, useState } from "react";
import { api, errorMessage, installCommand, type Me } from "@/lib/api";
import { CopyCommand } from "./copy-command";

// Project ids are used in URLs and the hook config, so keep them to a safe slug.
function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * "New project" flow for the dashboard: creates the project, then (for owners/
 * admins, who may mint tokens) mints an ingest token so the first agent can
 * connect, and hands back the one-line install command.
 */
export function ProjectCreate({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  // Tracks whether the user has hand-edited the id so we stop auto-deriving it from the name.
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // ingest is null when no token was minted; mintErr says why if minting failed.
  const [result, setResult] = useState<{ id: string; ingest: string | null; mintErr?: string } | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => { api.me().then(setMe).catch(() => {}); }, []);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Minting needs owner/admin (or the auth-off local instance). If me() is
  // unknown, try anyway: a refused mint is reported below.
  const canMint = !me || !me.auth || !!me.admin;
  const identity = me?.member || me?.user?.email || null;

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
    } catch (e) {
      setErr(`Could not create the project: ${errorMessage(e)}`);
      setBusy(false);
      return;
    }
    // The project exists now; a failed mint must not read as a failed create.
    let ingest: string | null = null;
    let mintErr: string | undefined;
    if (canMint) {
      // Mint an ingest token so the creator can immediately connect an agent.
      // access:false because the dashboard is reached through the logged-in account, not a token.
      try { ingest = (await api.invite(name.trim() || projectId, false)).ingest; }
      catch (e) { mintErr = errorMessage(e); }
    }
    setResult({ id: projectId, ingest, mintErr });
    onCreated?.();
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
                  {canMint && " We will mint an ingest token so your first agent can connect."}
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
                  Run this in your agent&rsquo;s repo to install the capture hook for <code>{result.id}</code>:
                </p>
                <CopyCommand block text={installCommand({ url: origin, me: identity, project: result.id, token: result.ingest })} />
                <p className="sub" style={{ fontSize: 13.5, margin: "16px 0 0" }}>
                  Then run <code>/hooks</code> in Claude Code to approve it.
                </p>
                {result.ingest ? (
                  <p className="mono muted" style={{ marginTop: 14, fontSize: 11.5 }}>
                    This ingest token is shown once. It is workspace-scoped. Revoke it any time from
                    &ldquo;manage tokens&rdquo; on the project page.
                  </p>
                ) : (
                  <p className="mono" style={{ marginTop: 14, fontSize: 11.5, color: "var(--blocked)" }}>
                    {result.mintErr
                      ? `No ingest token was minted (${result.mintErr}).`
                      : "Minting agent tokens needs the owner or admin role."}{" "}
                    Ask a workspace owner/admin for an ingest token and add <code>--token &lt;token&gt;</code> to the command.
                  </p>
                )}
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
