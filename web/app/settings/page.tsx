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
