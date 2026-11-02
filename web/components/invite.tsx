"use client";
import { useEffect, useState } from "react";
import { api, errorMessage, installCommand } from "@/lib/api";
import { CopyCommand } from "./copy-command";

/** Calls `close` on Escape while `open`, like a native dialog. */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
}

/**
 * Admin-only "invite a teammate" flow. Hands back an account join link (so the
 * teammate signs in as themselves, as a member) and, optionally, an ingest token
 * plus install command for their agent. It never mints a raw access token: those
 * bypass per-user accounts.
 */
export function Invite({ projectId }: { projectId: string }) {
  // The admin's workspace (null hides the button) and whether accounts exist at all.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [auth, setAuth] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ingest, setIngest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ url?: string; ingest?: string; name: string } | null>(null);

  useEffect(() => {
    api.me().then((m) => {
      setWorkspaceId(m.admin && m.workspace ? m.workspace.id : null);
      setAuth(m.auth);
    }).catch(() => {});
  }, []);
  useEscape(open, () => reset());
  if (!workspaceId) return null;

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const create = async () => {
    setErr(""); setBusy(true);
    try {
      const label = name.trim();
      // The auth-off local instance has no accounts, so no join link there (just
      // the install command, which always gets a token).
      const link = auth ? await api.inviteLink(workspaceId, "member", label || undefined) : null;
      const minted = ingest || !auth ? await api.invite(label, false) : null;
      // The server returns a relative join path when the request had no Origin.
      setResult({ url: link ? new URL(link.url, origin).href : undefined, ingest: minted?.ingest, name: label });
    } catch (e) {
      setErr(`Could not create the invite: ${errorMessage(e)}`);
    }
    setBusy(false);
  };

  const reset = () => { setOpen(false); setResult(null); setName(""); setIngest(true); setErr(""); };

  return (
    <>
      <button type="button" className="rz-btn ghost small" onClick={() => setOpen(true)}>+ Invite</button>
      {open && (
        <div className="invite-backdrop" onClick={reset}>
          <div className="invite-modal card pad" role="dialog" aria-modal="true" aria-labelledby="invite-title" onClick={(e) => e.stopPropagation()}>
            {!result ? (
              <>
                <div className="label" style={{ marginBottom: 12 }}><span className="sq blue" /> invite to {projectId}</div>
                <h3 id="invite-title" className="display" style={{ fontSize: 22, marginBottom: 6 }}>Invite a teammate</h3>
                <p className="sub" style={{ fontSize: 14, marginBottom: 18 }}>
                  {auth
                    ? `Creates a join link: they sign up or log in and land in this workspace as a member${ingest ? ", plus an ingest token and install command for their agent" : ""}.`
                    : "Gives you the install command for their agent."}
                </p>
                <label className="invite-l">Name (optional)</label>
                <input className="tokeninput" placeholder="e.g. Sofia" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
                {auth && (
                  <label className="invite-check">
                    <input type="checkbox" checked={ingest} onChange={(e) => setIngest(e.target.checked)} />
                    Also mint an ingest token for their agent
                  </label>
                )}
                {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button className="btn solid" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create invite"}</button>
                  <button className="btn ghost" onClick={reset}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="label" style={{ marginBottom: 12 }}><span className="sq active" /> invite ready</div>
                <h3 id="invite-title" className="display" style={{ fontSize: 22, marginBottom: 6 }}>Send this to {result.name || "your teammate"}</h3>
                {result.url && (
                  <>
                    <p className="sub" style={{ fontSize: 13.5, margin: "0 0 8px" }}>
                      1. Their join link (single use, expires in 7 days):
                    </p>
                    <CopyCommand block text={result.url} />
                  </>
                )}
                {result.ingest && (
                  <>
                    <p className="sub" style={{ fontSize: 13.5, margin: result.url ? "16px 0 8px" : "0 0 8px" }}>
                      {result.url ? "2. " : ""}Install the capture hook into Claude Code, then run <code>/hooks</code> to approve it:
                    </p>
                    {/* No --me: we don't know how they report; the hook defaults to their git email. */}
                    <CopyCommand block text={installCommand({ url: origin, project: projectId, token: result.ingest })} />
                    <p className="mono muted" style={{ marginTop: 14, fontSize: 11.5 }}>
                      The ingest token is shown once. It&rsquo;s workspace-scoped: revoke it any time from
                      &ldquo;Manage tokens&rdquo; on the project page.
                    </p>
                  </>
                )}
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button className="btn" onClick={() => setResult(null)}>Invite another</button>
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
