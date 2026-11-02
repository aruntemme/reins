"use client";
import { useEffect, useState } from "react";
import { api, errorMessage, type Me } from "@/lib/api";
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
 * "Invite teammates" for a project. Owners/admins create a single-use workspace
 * join link that lands the teammate on this project's connect page after they
 * sign up, where one command sets up their agent. No tokens change hands.
 * Everyone else is told who can send the link.
 */
export function Invite({ projectId }: { projectId: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => { api.me().then(setMe).catch(() => {}); }, []);
  const reset = () => { setOpen(false); setLink(null); setErr(""); };
  useEscape(open, reset);
  if (!me) return null;

  const origin = window.location.origin;
  const connectPath = `/project/${encodeURIComponent(projectId)}/connect`;
  const workspaceId = me.admin && me.workspace ? me.workspace.id : null;

  const create = async () => {
    if (!workspaceId) return;
    setErr(""); setBusy(true);
    try {
      const r = await api.inviteLink(workspaceId, "member");
      // The server returns a relative join path when the request had no Origin.
      const url = new URL(r.url, origin);
      url.searchParams.set("next", connectPath);
      setLink(url.href);
    } catch (e) {
      setErr(`Could not create the invite: ${errorMessage(e)}`);
    }
    setBusy(false);
  };

  return (
    <>
      <button type="button" className="rz-btn ghost small" onClick={() => setOpen(true)}>+ Invite</button>
      {open && (
        <div className="invite-backdrop" onClick={reset}>
          <div className="invite-modal card pad" role="dialog" aria-modal="true" aria-labelledby="invite-title" onClick={(e) => e.stopPropagation()}>
            <div className="label" style={{ marginBottom: 12 }}><span className="sq blue" /> invite to {projectId}</div>
            <h3 id="invite-title" className="display" style={{ fontSize: 22, marginBottom: 6 }}>Invite teammates</h3>
            {!me.auth ? (
              <>
                <p className="sub" style={{ fontSize: 14, marginBottom: 14 }}>
                  This instance has no accounts. A teammate runs this in their repo and the wizard does the rest:
                </p>
                <CopyCommand block text={`npx reins-hook --url ${origin} --project ${projectId}`} />
              </>
            ) : !workspaceId ? (
              <p className="sub" style={{ fontSize: 14, marginBottom: 6 }}>
                Only a workspace owner or admin can create join links. Ask one of them to invite your teammate; the link
                will bring them straight back to this project.
              </p>
            ) : !link ? (
              <>
                <p className="sub" style={{ fontSize: 14, marginBottom: 6 }}>
                  Create a single-use join link. Your teammate signs up, lands on this project&rsquo;s connect page and
                  runs one command in their repo. You don&rsquo;t send any tokens.
                </p>
                {err && <div className="mono" style={{ color: "var(--amber-text)", marginTop: 10 }} role="alert">{err}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button className="rz-btn primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create join link"}</button>
                  <button className="rz-btn ghost" onClick={reset}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p className="sub" style={{ fontSize: 13.5, margin: "0 0 8px" }}>
                  Send this link (single use, expires in 7 days). They join as a member, then see the one command to run:
                </p>
                <CopyCommand block text={link} />
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button className="rz-btn ghost" onClick={() => setLink(null)}>Create another</button>
                  <button className="rz-btn primary" onClick={reset}>Done</button>
                </div>
              </>
            )}
            {(!workspaceId || !me.auth) && (
              <div style={{ display: "flex", marginTop: 16 }}>
                <button className="rz-btn ghost" onClick={reset}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
