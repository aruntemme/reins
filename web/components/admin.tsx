"use client";
import { useCallback, useEffect, useState } from "react";
import { api, timeAgo, type Token } from "@/lib/api";

/**
 * Admin-only "manage tokens" flow: lists every workspace token and lets an
 * admin revoke any of them. Gated on api.me().admin so non-admins never see it,
 * matching how <Invite/> hides itself.
 *
 * Revoke uses an inline two-click confirm (the row arms, then a second click
 * commits) rather than window.confirm — a native confirm blocks the event loop
 * and feels broken inside a modal.
 */
export function ManageTokens() {
  const [admin, setAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [err, setErr] = useState("");
  // id of the token currently armed for a confirming second click.
  const [confirming, setConfirming] = useState<string | null>(null);
  // id of the token whose revoke request is in flight.
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { api.me().then((m) => setAdmin(!!m.admin)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await api.tokens();
      setTokens(r.tokens);
    } catch {
      setErr("Could not load tokens. Sign in with an admin token to manage them.");
    }
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!admin) return null;

  const revoke = async (id: string) => {
    setBusy(id);
    setErr("");
    try {
      await api.revokeToken(id);
      await load();
    } catch {
      setErr("Could not revoke that token. Try again.");
    }
    setConfirming(null);
    setBusy(null);
  };

  const reset = () => { setOpen(false); setConfirming(null); setErr(""); };

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>manage tokens</button>
      {open && (
        <div className="invite-backdrop" onClick={reset}>
          <div className="invite-modal card pad" onClick={(e) => e.stopPropagation()}>
            <div className="label" style={{ marginBottom: 12 }}><span className="sq blue" /> workspace tokens</div>
            <h3 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Manage tokens</h3>
            <p className="sub" style={{ fontSize: 14, marginBottom: 18 }}>
              Revoke any token to cut off the agent or dashboard session using it. Revoked tokens stop
              working immediately and cannot be restored.
            </p>
            {err && <div className="mono" style={{ color: "var(--blocked)", marginBottom: 12 }}>{err}</div>}
            {tokens === null ? (
              <div className="empty">Loading…</div>
            ) : tokens.length === 0 ? (
              <div className="empty">No tokens yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8, maxHeight: 360, overflowY: "auto" }}>
                {tokens.map((t) => (
                  <div
                    key={t.id}
                    className="pitem"
                    style={{ opacity: t.revoked ? 0.55 : 1 }}
                  >
                    <div className="ptext" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="chip">{t.kind}</span>
                      <code className="mono">{t.prefix}…</code>
                      {t.label && <span className="sub" style={{ fontSize: 13 }}>{t.label}</span>}
                    </div>
                    <div className="pmeta">
                      <span className="mono">
                        {t.revoked ? "revoked" : "active"}
                        {" · "}
                        {t.last_used ? `last used ${timeAgo(t.last_used)}` : "never used"}
                      </span>
                      <div className="acts">
                        {t.revoked ? (
                          <span className="tiny claimed">revoked</span>
                        ) : busy === t.id ? (
                          <span className="tiny">revoking…</span>
                        ) : confirming === t.id ? (
                          <>
                            <button className="tiny" onClick={() => revoke(t.id)}>confirm</button>
                            <button className="tiny" onClick={() => setConfirming(null)}>cancel</button>
                          </>
                        ) : (
                          <button className="tiny" onClick={() => setConfirming(t.id)}>revoke</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button className="btn ghost" onClick={reset}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
