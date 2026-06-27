"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api, timeAgo, type ProjectSummary } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar } from "@/components/ui";
import { ProjectCreate } from "@/components/project-create";

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [llm, setLlm] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Gate: if auth is on and there's no session, bounce to /login (the account
  // entry). The token-paste /signin page is reachable via "Try the demo".
  useEffect(() => {
    api.me().then((m) => {
      if (m.auth && !m.workspace && typeof window !== "undefined") window.location.href = "/login";
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.projects();
      setProjects(r.projects);
      setLlm(r.llm);
    } catch (e) {
      if (handleAuth(e)) return;
      /* server may be down */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const live = useStream(undefined, load);

  return (
    <>
      <TopBar brandHref="/dashboard" live={live} />
      <main className="wrap">
        <section className="dashtop">
          <div className="label eyebrow"><span className="sq" /> live context · for agent teams</div>
          <h1 className="display" style={{ fontSize: "clamp(34px, 5vw, 56px)" }}>
            Your team, <span className="hl">live</span>.
          </h1>
        </section>

        {!llm && loaded && (
          <div className="banner" style={{ marginBottom: 24 }}>
            ⚠ No LLM configured: running in degraded mode (raw capture, no distillation). Set
            <code style={{ margin: "0 4px" }}>REINS_LLM_API_KEY</code> in the server.
          </div>
        )}

        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12 }}
        >
          <div className="label" style={{ marginBottom: 0 }}><span className="sq blue" /> projects</div>
          <ProjectCreate onCreated={load} />
        </div>
        {projects.length === 0 ? (
          <div className="card pad empty">
            {loaded
              ? "No projects yet. Point an agent's hook at the server (npx reins-hook install)."
              : "Loading…"}
          </div>
        ) : (
          <div className="grid projects">
            {projects.map((p) => (
              <Link key={p.id} href={`/project/${encodeURIComponent(p.id)}`} className="card pcard">
                <div className="label"><span className="sq" /> {p.id}</div>
                <h3>{p.name}</h3>
                <div className="goal">{p.goal || "No goal set yet."}</div>
                <div className="foot">
                  <div className="mono">{p.active}/{p.members} active</div>
                  <div className="mono">{timeAgo(p.updatedAt)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      <footer className="foot">
        <div className="wrap">reins · <Link href="/privacy">privacy</Link></div>
      </footer>
    </>
  );
}
