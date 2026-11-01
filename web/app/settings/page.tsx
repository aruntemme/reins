"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, errorMessage, type Me } from "@/lib/api";
import { toLogin } from "@/lib/guard";
import { TopBar } from "@/components/ui";
import { Members } from "@/components/members";
import { Providers } from "@/components/providers";

/** Each account sets the capture identity (the hook's --me) it acts as, tying the
 *  account to its activity and goals. Available to every logged-in user. */
function IdentityCard({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [val, setVal] = useState(me.member ?? "");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setVal(me.member ?? ""); }, [me.member]);
  const save = async () => {
    setErr("");
    try {
      await api.setMember(val.trim());
    } catch (e) {
      setErr(errorMessage(e));
      return;
    }
    setSaved(true);
    onSaved();
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="card pad" style={{ marginBottom: 16 }}>
      <div className="label" style={{ marginBottom: 10 }}><span className="sq blue" /> your identity</div>
      <p className="sub" style={{ fontSize: 14, marginBottom: 12 }}>
        How your coding agent reports you — the hook&rsquo;s <code>--me</code>. This ties your account to your
        activity and goals on the board. Defaults to your email.
      </p>
      <div style={{ display: "flex", gap: 8, maxWidth: 440, alignItems: "center" }}>
        <input className="tokeninput" style={{ flex: 1 }} value={val} placeholder={me.user?.email || "your-name"} onChange={(e) => setVal(e.target.value)} />
        <button className="btn solid" onClick={save}>Save</button>
        {saved && <span className="mono" style={{ color: "var(--active)", fontSize: 12 }}>saved</span>}
      </div>
      {err && <div className="mono" style={{ color: "var(--blocked)", marginTop: 10 }}>{err}</div>}
    </div>
  );
}

/** A labelled on/off switch row used by the opt-in and privacy cards. */
function Toggle({ on, onChange, label, busy }: { on: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden><span className="toggle-knob" /></span>
      <span>{label}</span>
    </label>
  );
}

/** Each member decides whether their learned traits are put to work. Off by default. */
function TraitsSharingCard({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [on, setOn] = useState(!!me.shareTraits);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setOn(!!me.shareTraits); }, [me.shareTraits]);
  const save = async (v: boolean) => {
    setErr("");
    setBusy(true);
    try {
      const r = await api.setTraitsSharing(v);
      setOn(r.shareTraits);
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card pad" style={{ marginBottom: 16 }}>
      <div className="label" style={{ marginBottom: 10 }}><span className="sq blue" /> your grain, put to work</div>
      <p className="sub" style={{ fontSize: 14, marginBottom: 12 }}>
        Reins learns your working style from activity (never raw prompts). With this on, your agent gets your
        strongest traits at session start, and handoffs routed to you carry the ones relevant to the task.
        Teammates can already read your profile on the board; this only controls what agents receive.
      </p>
      <Toggle on={on} busy={busy} onChange={save} label={on ? "Sharing my traits with agents" : "Not shared with agents"} />
      {err && <div className="mono" style={{ color: "var(--blocked)", marginTop: 10 }}>{err}</div>}
    </div>
  );
}

/** Admin: hide branch names from teammates and the LLM (collisions still count). */
function PrivacyCard() {
  const [hide, setHide] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { api.workspaceSettings().then((s) => setHide(s.hideBranches)).catch((e) => setErr(errorMessage(e))); }, []);
  const save = async (v: boolean) => {
    setErr("");
    setBusy(true);
    try {
      setHide((await api.setWorkspaceSettings({ hideBranches: v })).hideBranches);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card pad">
      <div className="label" style={{ marginBottom: 10 }}><span className="sq" /> privacy</div>
      <p className="sub" style={{ fontSize: 14, marginBottom: 12 }}>
        Each hook reports its git branch, so the board can show it and spot two people on the same branch.
        Hide branch names to keep them off member cards, agent context, and model prompts; same-branch
        collisions are still detected, just unnamed.
      </p>
      {hide === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <Toggle on={hide} busy={busy} onChange={save} label={hide ? "Branch names hidden" : "Branch names visible to the team"} />
      )}
      {err && <div className="mono" style={{ color: "var(--blocked)", marginTop: 10 }}>{err}</div>}
    </div>
  );
}

/**
 * Workspace settings. Gated on api.me().admin (owner/admin). The members and
 * invite controls live in <Members/>; non-admins get a short pointer to ask an
 * owner/admin instead of seeing controls the server would reject anyway.
 */
export default function Settings() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.me()
      .then((m) => {
        // No session at all: send them to sign in. Token sessions (e.g. an admin
        // token) have a workspace but no user, and may stay.
        if (m.auth && !m.workspace) toLogin();
        setMe(m);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const workspace = me?.workspace;
  const isAdmin = !!me?.admin;

  return (
    <>
      <TopBar brandHref="/dashboard" hideLive />
      <main className="wrap">
        <div className="dash">
          <div className="dashhead">
            <div className="crumbs">
              <Link href="/dashboard" className="mono" style={{ color: "var(--ink-3)" }}>dashboard</Link>
              <span className="mono" style={{ color: "var(--ink-3)" }}>/</span>
              <span className="mono">settings</span>
            </div>
            <h1 className="display" style={{ fontSize: "clamp(30px, 4vw, 44px)" }}>
              {workspace?.name ?? "Workspace"}
            </h1>
          </div>

          {!loaded ? (
            <div className="empty">Loading…</div>
          ) : !workspace ? (
            <div className="card pad empty">No workspace in this session.</div>
          ) : (
            <>
              {me?.user && <IdentityCard me={me} onSaved={() => api.me().then(setMe).catch(() => {})} />}
              {me?.user && <TraitsSharingCard me={me} onSaved={() => api.me().then(setMe).catch(() => {})} />}
              {!isAdmin ? (
                <div className="card pad">
                  <div className="label" style={{ marginBottom: 12 }}><span className="sq" /> members</div>
                  <p className="sub" style={{ fontSize: 15 }}>
                    Only owners and admins can manage members and invites. Ask an owner or admin of
                    {" "}<strong>{workspace.name}</strong> if you need to add a teammate or change a role.
                  </p>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 28 }}>
                  <Providers />
                  <PrivacyCard />
                  <Members workspaceId={workspace.id} currentEmail={me?.user?.email} />
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <footer className="foot">
        <div className="wrap">reins · <Link href="/privacy">privacy</Link></div>
      </footer>
    </>
  );
}
