"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Me } from "@/lib/api";
import { TopBar } from "@/components/ui";
import { Members } from "@/components/members";

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
        // No account session at all: send them to sign in.
        if (m.auth && !m.user && typeof window !== "undefined") window.location.href = "/signin";
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
          ) : !isAdmin ? (
            <div className="card pad">
              <div className="label" style={{ marginBottom: 12 }}><span className="sq" /> members</div>
              <p className="sub" style={{ fontSize: 15 }}>
                Only owners and admins can manage members and invites. Ask an owner or admin of
                {" "}<strong>{workspace.name}</strong> if you need to add a teammate or change a role.
              </p>
            </div>
          ) : (
            <Members workspaceId={workspace.id} currentEmail={me?.user?.email} />
          )}
        </div>
      </main>
      <footer className="foot">
        <div className="wrap">reins · hook / distill / live shared context / MCP retrieval</div>
      </footer>
    </>
  );
}
