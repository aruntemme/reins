"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api, errorMessage, timeAgo, type ProjectSummary } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth, toLogin } from "@/lib/guard";
import { TopBar } from "@/components/ui";
import { ProjectCreate } from "@/components/project-create";
import "./dashboard.css";

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [llm, setLlm] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [welcome, setWelcome] = useState(false);

  // Gate: if auth is on and there's no session, bounce to /login (the account
  // entry). The token-paste /signin page is reachable via "Try the demo".
  useEffect(() => { setWelcome(new URLSearchParams(window.location.search).has("welcome")); }, []);

  useEffect(() => {
    api.me().then((m) => {
      if (m.auth && !m.workspace) toLogin();
      else if (m.workspace) setWorkspace(m.workspace.name);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.projects();
      setProjects(r.projects);
      setLlm(r.llm);
      setLoadErr("");
    } catch (e) {
      if (handleAuth(e)) return;
      setLoadErr(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const live = useStream(undefined, load);

  return (
    <>
      <TopBar brandHref="/dashboard" live={live} />
      <main className="db-wrap">
        <section className="db-top">
          <p className="rz-eyebrow">{workspace ? `${workspace} · live context` : "Live context · for agent teams"}</p>
          <h1 className="db-title">Your team, live.</h1>
        </section>

        {!llm && loaded && (
          <div className="db-banner" role="status">
            No model provider configured: running in degraded mode (raw capture, no distillation). Add one in{" "}
            <Link href="/settings">settings → model providers</Link>.
          </div>
        )}

        <div className="db-bar">
          <h2 className="rz-section-h">Projects{loaded && projects.length > 0 ? ` · ${projects.length}` : ""}</h2>
          <ProjectCreate onCreated={load} startOpen={welcome} />
        </div>

        {!loaded ? (
          <div className="db-grid" aria-busy="true" aria-label="Loading projects">
            {[0, 1, 2].map((i) => <div key={i} className="db-card db-skel" />)}
          </div>
        ) : loadErr && projects.length === 0 ? (
          <div className="db-empty" role="alert">
            <p>Could not load your projects: {loadErr}</p>
            <button type="button" className="rz-btn ghost small" onClick={load}>Try again</button>
          </div>
        ) : projects.length === 0 ? (
          <div className="db-empty">
            <p><b>No projects yet.</b></p>
            <p>Create one to get the install command for your first agent.</p>
          </div>
        ) : (
          <div className="db-grid">
            {projects.map((p) => (
              <article key={p.id} className="db-card">
                <div className="db-card-top">
                  <span className="db-id">{p.id}</span>
                  {p.members === 0 ? (
                    <span className="db-state">No agents yet</span>
                  ) : (
                    <span className={`db-state${p.active > 0 ? " on" : ""}`}>
                      <span className={`rz-live${p.active > 0 ? "" : " away"}`} aria-hidden="true" />
                      {p.active}/{p.members} active
                    </span>
                  )}
                </div>
                <h3 className="db-name">
                  <Link href={`/project/${encodeURIComponent(p.id)}`} className="db-card-link">{p.name}</Link>
                </h3>
                <p className="db-goal">{p.goal || (p.open ? `${p.open} open item${p.open === 1 ? "" : "s"}` : "Nothing tracked yet.")}</p>
                <div className="db-foot">
                  <span>Updated {timeAgo(p.updatedAt)}</span>
                  {p.members === 0 && (
                    <Link href={`/project/${encodeURIComponent(p.id)}/connect`} className="db-connect">Connect an agent</Link>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
      <footer className="db-footer">
        <div className="db-wrap">reins · <Link href="/privacy">privacy</Link></div>
      </footer>
    </>
  );
}
