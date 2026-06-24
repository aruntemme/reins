"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CopyCommand } from "./copy-command";

function slug(name: string | null) {
  return (name || "teammate").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teammate";
}

/** Admin-only "invite a teammate" flow: mints tokens and hands back the install command. */
export function Invite({ projectId }: { projectId: string }) {
  const [admin, setAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ ingest: string; access?: string; name: string | null } | null>(null);

  useEffect(() => { api.me().then((m) => setAdmin(!!m.admin)).catch(() => {}); }, []);
  if (!admin) return null;

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const create = async () => {
    setErr(""); setBusy(true);
    try {
      const r = await api.invite(name.trim(), access);
      setResult({ ingest: r.ingest, access: r.access, name: r.name });
    } catch {
      setErr("Could not create the invite. Sign in with an admin token to invite people.");
    }
    setBusy(false);
  };

  const reset = () => { setOpen(false); setResult(null); setName(""); setAccess(true); setErr(""); };

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>+ invite</button>
      {open && (
        <div className="invite-backdrop" onClick={reset}>
          <div className="invite-modal card pad" onClick={(e) => e.stopPropagation()}>
            {!result ? (
              <>
                <div className="label" style={{ marginBottom: 12 }}><span className="sq blue" /> invite to {projectId}</div>
                <h3 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Invite a teammate</h3>
                <p className="sub" style={{ fontSize: 14, marginBottom: 18 }}>
                  Mints an ingest token for their agent{access ? ", plus an access token for the dashboard" : ""}.
                  Send them the install command on the next screen.
                </p>
                <label className="invite-l">Name (optional)</label>
                <input className="tokeninput" placeholder="e.g. Sofia" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
                <label className="invite-check">
                  <input type="checkbox" checked={access} onChange={(e) => setAccess(e.target.checked)} />
                  Also give dashboard access (mint an access token)
                </label>
                {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button className="btn solid" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create invite"}</button>
                  <button className="btn ghost" onClick={reset}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="label" style={{ marginBottom: 12 }}><span className="sq active" /> invite ready</div>
                <h3 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Send this to {result.name || "your teammate"}</h3>
                <p className="sub" style={{ fontSize: 13.5, margin: "0 0 8px" }}>
                  1. Install the capture hook into Claude Code, then run <code>/hooks</code> to approve it:
                </p>
                <CopyCommand block text={`npx reins-hook install --url ${origin} --me ${slug(result.name)} --project ${projectId} --token ${result.ingest}`} />
                {result.access && (
                  <>
                    <p className="sub" style={{ fontSize: 13.5, margin: "16px 0 8px" }}>
                      2. View the board — paste this access token at <code>/signin</code>:
                    </p>
                    <CopyCommand block text={result.access} />
                  </>
                )}
                <p className="mono muted" style={{ marginTop: 14, fontSize: 11.5 }}>
                  These tokens are shown once. They’re workspace-scoped — revoke any time with the admin CLI.
                </p>
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
