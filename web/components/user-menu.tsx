"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type Me, type WorkspaceMembership } from "@/lib/api";
import { initials } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import "./user-menu.css";

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
    <div ref={ref} className="um">
      <button
        type="button"
        className="um-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${email}`}
      >
        <span className="um-av" aria-hidden="true">{initials(email)}</span>
        {/* Hidden on narrow screens (user-menu.css), leaving the initials. */}
        <span className="um-email">{email}</span>
        <svg className="um-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="um-panel">
          <div className="um-head">
            <span className="um-av" aria-hidden="true">{initials(email)}</span>
            <div className="um-head-text">
              <span className="um-eyebrow">signed in as</span>
              <span className="um-name">{email}</span>
            </div>
          </div>

          {showSwitcher && (
            <div className="um-group">
              <div className="um-eyebrow">workspaces</div>
              {workspaces.map((w) => {
                const active = w.id === currentId;
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitem"
                    className={`um-item${active ? " current" : ""}`}
                    onClick={() => switchTo(w.id)}
                    disabled={switching !== null}
                  >
                    <span className="um-item-name">{w.name}</span>
                    <span className="um-item-meta">
                      {switching === w.id ? "switching…" : active ? "current" : w.role}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="um-group">
            <div className="um-eyebrow" aria-hidden="true">theme</div>
            <ThemeToggle />
          </div>

          <div className="um-group">
            <Link href="/settings" role="menuitem" className="um-item" onClick={() => setOpen(false)}>
              Settings
            </Link>
            <button type="button" role="menuitem" className="um-item" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
