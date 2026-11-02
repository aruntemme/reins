"use client";
import { useCallback, useEffect, useState } from "react";
import { api, timeAgo, type WorkspaceMember, type Role } from "@/lib/api";
import { Avatar } from "@/components/ui";
import { CopyCommand } from "@/components/copy-command";

const ROLES: Role[] = ["owner", "admin", "member"];

/**
 * Workspace members management, shown on /settings for owners/admins.
 *
 * Guards against demoting/removing the last owner on the client by counting
 * owners and disabling those controls. The server enforces this too (countOwners),
 * but disabling here avoids a confusing failed request and keeps the UI honest.
 */
export function Members({ workspaceId, currentEmail }: { workspaceId: string; currentEmail?: string }) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [err, setErr] = useState("");
  // userId of the member whose remove is armed for a confirming second click.
  const [confirming, setConfirming] = useState<string | null>(null);
  // userId of the member with a request in flight (role change or remove).
  const [busy, setBusy] = useState<string | null>(null);

  // Invite control state.
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await api.members(workspaceId);
      setMembers(r.members);
    } catch {
      setErr("Could not load members. Try again.");
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const ownerCount = (members ?? []).filter((m) => m.role === "owner").length;

  const changeRole = async (m: WorkspaceMember, role: Role) => {
    if (role === m.role) return;
    setBusy(m.userId);
    setErr("");
    try {
      await api.setMemberRole(workspaceId, m.userId, role);
      await load();
    } catch {
      setErr("Could not change that role. Try again.");
    }
    setBusy(null);
  };

  const remove = async (m: WorkspaceMember) => {
    setBusy(m.userId);
    setErr("");
    try {
      await api.removeMember(workspaceId, m.userId);
      await load();
    } catch {
      setErr("Could not remove that member. Try again.");
    }
    setConfirming(null);
    setBusy(null);
  };

  const makeInvite = async () => {
    setInviteBusy(true);
    setInviteErr("");
    setInviteUrl(null);
    try {
      const r = await api.inviteLink(workspaceId, inviteRole);
      setInviteUrl(r.url);
    } catch {
      setInviteErr("Could not create an invite link. Try again.");
    }
    setInviteBusy(false);
  };

  return (
    <section id="members" className="st-section" aria-labelledby="st-h-members">
      <h2 id="st-h-members" className="rz-section-h">Members</h2>
      {err && <p className="st-err" role="alert">{err}</p>}
      <div className="rz-card st-card">
        {members === null ? (
          <p className="st-empty">Loading…</p>
        ) : members.length === 0 ? (
          <p className="st-empty">No members yet.</p>
        ) : (
          <ul className="st-list">
            {members.map((m, i) => {
              // The last owner cannot be demoted or removed: it would orphan the workspace.
              const isLastOwner = m.role === "owner" && ownerCount <= 1;
              const rowBusy = busy === m.userId;
              return (
                <li key={m.userId} className="st-item">
                  <div className="st-who">
                    <Avatar name={m.email} i={i} />
                    <div className="st-who-text">
                      <span className="st-who-name">
                        {m.email}
                        {m.email === currentEmail && <span className="st-you">(you)</span>}
                      </span>
                      <span className="st-who-sub">joined {timeAgo(m.createdAt)}</span>
                    </div>
                  </div>
                  <div className="st-ctrl">
                    <select
                      className="st-select"
                      value={m.role}
                      disabled={rowBusy || isLastOwner}
                      onChange={(e) => changeRole(m, e.target.value as Role)}
                      aria-label={`Role for ${m.email}`}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    {rowBusy ? (
                      <span className="st-working" role="status">working…</span>
                    ) : confirming === m.userId ? (
                      <>
                        <button className="rz-btn small warn" onClick={() => remove(m)}>Confirm remove</button>
                        <button className="rz-btn small ghost" onClick={() => setConfirming(null)}>Cancel</button>
                      </>
                    ) : (
                      <button
                        className="rz-btn small ghost"
                        disabled={isLastOwner}
                        title={isLastOwner ? "The last owner cannot be removed" : undefined}
                        aria-label={`Remove ${m.email}`}
                        onClick={() => setConfirming(m.userId)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="rz-card st-card">
        <h3 className="st-title">Invite a teammate</h3>
        <p className="st-desc">
          Create a join link and send it to a teammate. They sign up or sign in, then land in this workspace
          with the role you pick.
        </p>
        <div className="st-inline">
          <label className="st-field row">
            <span className="st-label">Role</span>
            <select className="st-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button className="rz-btn primary" onClick={makeInvite} disabled={inviteBusy}>
            {inviteBusy ? "Creating…" : "Create invite link"}
          </button>
        </div>
        {inviteErr && <p className="st-err" role="alert">{inviteErr}</p>}
        {inviteUrl && (
          <div style={{ display: "grid", gap: 6 }}>
            <span className="st-note">Share this link (click to copy)</span>
            <CopyCommand block text={inviteUrl} />
          </div>
        )}
      </div>
    </section>
  );
}
