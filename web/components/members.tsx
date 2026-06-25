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
    <div style={{ display: "grid", gap: 28 }}>
      <section>
        <div className="label" style={{ marginBottom: 14 }}><span className="sq blue" /> members</div>
        {err && <div className="mono" style={{ color: "var(--blocked)", marginBottom: 12 }}>{err}</div>}
        {members === null ? (
          <div className="empty">Loading…</div>
        ) : members.length === 0 ? (
          <div className="empty">No members yet.</div>
        ) : (
          <div className="card pad" style={{ display: "grid", gap: 14 }}>
            {members.map((m, i) => {
              // The last owner cannot be demoted or removed: it would orphan the workspace.
              const isLastOwner = m.role === "owner" && ownerCount <= 1;
              const rowBusy = busy === m.userId;
              return (
                <div key={m.userId} className="pitem">
                  <div className="ptext" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={m.email} i={i} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.email}
                      {m.email === currentEmail && <span className="sub" style={{ fontSize: 12, marginLeft: 6 }}>(you)</span>}
                    </span>
                  </div>
                  <div className="pmeta">
                    <span className="mono" style={{ fontSize: 12 }}>joined {timeAgo(m.createdAt)}</span>
                    <div className="acts" style={{ alignItems: "center" }}>
                      <select
                        className="tiny"
                        value={m.role}
                        disabled={rowBusy || isLastOwner}
                        onChange={(e) => changeRole(m, e.target.value as Role)}
                        aria-label={`Role for ${m.email}`}
                        style={{ paddingRight: 8 }}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      {rowBusy ? (
                        <span className="tiny">working…</span>
                      ) : confirming === m.userId ? (
                        <>
                          <button className="tiny" onClick={() => remove(m)}>confirm</button>
                          <button className="tiny" onClick={() => setConfirming(null)}>cancel</button>
                        </>
                      ) : (
                        <button
                          className="tiny"
                          disabled={isLastOwner}
                          title={isLastOwner ? "The last owner cannot be removed" : undefined}
                          onClick={() => setConfirming(m.userId)}
                        >
                          remove
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="label" style={{ marginBottom: 14 }}><span className="sq" /> invite a teammate</div>
        <div className="card pad" style={{ display: "grid", gap: 14 }}>
          <p className="sub" style={{ fontSize: 14 }}>
            Create a join link and send it to a teammate. They sign up or sign in, then land in this workspace
            with the role you pick.
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              className="tokeninput"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              aria-label="Invite role"
              style={{ padding: "10px 14px" }}
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn solid" onClick={makeInvite} disabled={inviteBusy}>
              {inviteBusy ? "creating…" : "create invite link"}
            </button>
          </div>
          {inviteErr && <div className="mono" style={{ color: "var(--blocked)" }}>{inviteErr}</div>}
          {inviteUrl && (
            <div style={{ display: "grid", gap: 6 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>share this link (click to copy)</div>
              <CopyCommand block text={inviteUrl} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
