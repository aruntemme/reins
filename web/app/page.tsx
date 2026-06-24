"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api, timeAgo, type ProjectSummary } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar } from "@/components/ui";

export default function Home() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [llm, setLlm] = useState(true);
  const [loaded, setLoaded] = useState(false);

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
      <TopBar live={live} />
      <main className="wrap">
        <section className="hero">
          <div className="label eyebrow"><span className="sq" /> live context · for agent teams</div>
          <h1 className="display">
            The context your team<br />actually <span className="hl">shares</span>.
          </h1>
          <p className="sub">
            Every teammate&rsquo;s AI agent reports what it&rsquo;s doing. Reins distills it live into
            one shared brain — so a lead can glance at status and a peer can grab what&rsquo;s pending,
            without a single standup.
          </p>
        </section>

        {!llm && loaded && (
          <div className="banner" style={{ marginBottom: 24 }}>
            ⚠ No LLM configured — running in degraded mode (raw capture, no distillation). Set
            <code style={{ margin: "0 4px" }}>REINS_LLM_API_KEY</code> in the server.
          </div>
        )}

        <div className="label" style={{ marginBottom: 14 }}><span className="sq blue" /> projects</div>
        {projects.length === 0 ? (
          <div className="card pad empty">
            {loaded
              ? "No projects yet. Point an agent's hook at the server, or run the seed script."
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
        <div className="wrap">reins · hook → distill → live shared context → MCP retrieval</div>
      </footer>
    </>
  );
}
