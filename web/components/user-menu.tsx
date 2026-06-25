"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type Me, type WorkspaceMembership } from "@/lib/api";
import { initials } from "@/components/ui";

/**
 * Account dropdown for the TopBar. Only renders when api.me() reports a real
 * logged-in user account (m.user). Token sessions have no user, so this stays
 * hidden and the TopBar falls back to its plain behaviour.
 *
 * Why fetch me() here instead of taking it as a prop: the TopBar is used on many
 * pages that do not already load me(), and we want the menu to appear everywhere
 * without changing each caller. We tolerate failures (server down / no auth).
 */
export function UserMenu() {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  // workspaceId currently being switched to, so we can show a pending state.
  const [switching, setSwitching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => {});
  }, []);

  // Close the menu on an outside click or Escape, like a native menu would.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Only show for real accounts. Token sessions (m.user absent) get no menu.
  if (!me?.user) return null;

  const email = me.user.email;
  const workspaces: WorkspaceMembership[] = me.workspaces ?? [];
  const currentId = me.workspace?.id;
  // The switcher is only useful when the account belongs to more than one team.
  const showSwitcher = workspaces.length > 1;

  const switchTo = async (workspaceId: string) => {
    if (workspaceId === currentId) { setOpen(false); return; }
    setSwitching(workspaceId);
    try {
      await api.switchWorkspace(workspaceId);
      // Reload so every page re-reads the new workspace context from scratch.
      window.location.reload();
    } catch {
      setSwitching(null);
    }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* clear client state regardless */ }
    window.location.href = "/login";
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span className="av" style={{ margin: 0, width: 22, height: 22, fontSize: 10 }}>{initials(email)}</span>
        <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 260,
            padding: 8,
            zIndex: 50,
            boxShadow: "0 12px 32px rgba(27,26,23,.14)",
          }}
        >
          <div style={{ padding: "8px 10px 10px" }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".06em" }}>
              signed in as
            </div>
            <div style={{ fontSize: 14, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {email}
            </div>
          </div>

          {showSwitcher && (
            <div style={{ borderTop: "1px solid var(--line)", padding: "8px 4px 4px" }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", padding: "0 6px 6px", textTransform: "uppercase", letterSpacing: ".06em" }}>
                workspaces
              </div>
              <div style={{ display: "grid", gap: 2 }}>
                {workspaces.map((w) => {
                  const active = w.id === currentId;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      role="menuitem"
                      onClick={() => switchTo(w.id)}
                      disabled={switching !== null}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                        width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 8,
                        border: "1px solid transparent", background: active ? "var(--bg)" : "transparent",
                        color: "var(--ink)", cursor: switching ? "default" : "pointer", fontSize: 14,
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {switching === w.id ? "switching…" : active ? "current" : w.role}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 4, display: "grid", gap: 2 }}>
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              style={{ display: "block", padding: "9px 10px", borderRadius: 8, color: "var(--ink)", fontSize: 14 }}
            >
              Settings
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "9px 10px", borderRadius: 8,
                border: "1px solid transparent", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 14,
              }}
            >
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
