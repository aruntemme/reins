"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, errorMessage, type Me } from "@/lib/api";
import { toLogin } from "@/lib/guard";
import { TopBar } from "@/components/ui";
import { Members } from "@/components/members";
import { Providers } from "@/components/providers";
import "./settings.css";

/** Each account sets the capture identity (the hook's --me) it acts as, tying the
 *  account to its activity and goals. Available to every logged-in user. */
function IdentityCard({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [val, setVal] = useState(me.member ?? "");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const inputId = useId();
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
    <div className="rz-card st-card">
      <h3 className="st-title">Your identity</h3>
      <p className="st-desc">
        How your coding agent reports you — the hook&rsquo;s <code>--me</code>. This ties your account to your
        activity and goals on the board. Defaults to your email.
      </p>
      <div className="st-field">
        <label className="st-label" htmlFor={inputId}>Capture name</label>
        <div className="st-inline">
          <input id={inputId} className="st-input mono" value={val} placeholder={me.user?.email || "your-name"} onChange={(e) => setVal(e.target.value)} />
          <button className="rz-btn primary" onClick={save}>Save</button>
          <span className="st-saved" role="status">{saved ? "saved" : ""}</span>
        </div>
      </div>
      {err && <p className="st-err" role="alert">{err}</p>}
    </div>
  );
}

/** A labelled on/off switch row used by the opt-in and privacy cards. */
function Toggle({ on, onChange, label, busy }: { on: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean }) {
  return (
    <label className="st-toggle">
      <input type="checkbox" role="switch" checked={on} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      <span className="st-track" aria-hidden><span className="st-knob" /></span>
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
    <div className="rz-card st-card">
      <h3 className="st-title">Your grain, put to work</h3>
      <p className="st-desc">
        Reins learns your working style from activity (never raw prompts). With this on, your agent gets your
        strongest traits at session start, and handoffs routed to you carry the ones relevant to the task.
        Teammates can already read your profile on the board; this only controls what agents receive.
      </p>
      <Toggle on={on} busy={busy} onChange={save} label={on ? "Sharing my traits with agents" : "Not shared with agents"} />
      {err && <p className="st-err" role="alert">{err}</p>}
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
    <div className="rz-card st-card">
      <h3 className="st-title">Privacy</h3>
      <p className="st-desc">
        Each hook reports its git branch, so the board can show it and spot two people on the same branch.
        Hide branch names to keep them off member cards, agent context, and model prompts; same-branch
        collisions are still detected, just unnamed.
      </p>
      {hide === null ? (
        <p className="st-empty">Loading…</p>
      ) : (
        <Toggle on={hide} busy={busy} onChange={save} label={hide ? "Branch names hidden" : "Branch names visible to the team"} />
      )}
      {err && <p className="st-err" role="alert">{err}</p>}
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
  const refresh = () => api.me().then(setMe).catch(() => {});

  const sections: { id: string; label: string }[] = [];
  if (workspace) {
    if (isAdmin) sections.push({ id: "workspace", label: "Workspace" });
    sections.push({ id: "members", label: "Members" });
    if (isAdmin) sections.push({ id: "providers", label: "Model providers" });
    if (me?.user) sections.push({ id: "account", label: "Account" });
  }

  const [current, setCurrent] = useState("");
  useEffect(() => {
    const sync = () => setCurrent(window.location.hash.slice(1));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const active = sections.some((x) => x.id === current) ? current : sections[0]?.id;

  return (
    <>
      <TopBar brandHref="/dashboard" hideLive />
      <main className="st-page">
        <div className="wrap">
          <div className="st-head">
            <nav className="st-crumbs" aria-label="Breadcrumb">
              <Link href="/dashboard">Dashboard</Link>
              <span aria-hidden="true">/</span>
              <b>Settings</b>
            </nav>
            <h1 className="st-title-h">{workspace?.name ?? "Workspace"}</h1>
          </div>

          {!loaded ? (
            <p className="st-empty">Loading…</p>
          ) : !workspace ? (
            <div className="rz-card st-card"><p className="st-empty">No workspace in this session.</p></div>
          ) : (
            <div className="st-layout">
              <nav className="st-nav" aria-label="Settings sections">
                {sections.map((x) => (
                  <a key={x.id} href={`#${x.id}`} aria-current={x.id === active ? "true" : undefined}>{x.label}</a>
                ))}
              </nav>
              <div className="st-main">
                {isAdmin && (
                  <section id="workspace" className="st-section" aria-labelledby="st-h-workspace">
                    <h2 id="st-h-workspace" className="rz-section-h">Workspace</h2>
                    <PrivacyCard />
                  </section>
                )}
                {isAdmin ? (
                  <Members workspaceId={workspace.id} currentEmail={me?.user?.email} />
                ) : (
                  <section id="members" className="st-section" aria-labelledby="st-h-members">
                    <h2 id="st-h-members" className="rz-section-h">Members</h2>
                    <div className="rz-card st-card">
                      <p className="st-desc">
                        Only owners and admins can manage members and invites. Ask an owner or admin of
                        {" "}<strong>{workspace.name}</strong> if you need to add a teammate or change a role.
                      </p>
                    </div>
                  </section>
                )}
                {isAdmin && <Providers />}
                {me?.user && (
                  <section id="account" className="st-section" aria-labelledby="st-h-account">
                    <h2 id="st-h-account" className="rz-section-h">Account</h2>
                    <IdentityCard me={me} onSaved={refresh} />
                    <TraitsSharingCard me={me} onSaved={refresh} />
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
      <footer className="foot">
        <div className="wrap">reins · <Link href="/privacy">privacy</Link></div>
      </footer>
    </>
  );
}
