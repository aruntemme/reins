"use client";
import "./lead.css";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ProjectTabs } from "@/components/project-tabs";
import { api, ApiError, errorMessage, type Project, type Goal, type GoalProposal } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { Mark } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import { DirectiveBand, Assignments } from "@/components/lead";
import { Goals, Proposals, type Viewer } from "@/components/goals";

type Search = Record<string, string | string[] | undefined>;

export default function LeadConsole({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = use(params);
  const sp = use(searchParams);
  // /lead?assign=<area>&suggest=<member,member> opens the assign form prefilled.
  const prefill = typeof sp.assign === "string" && sp.assign.trim()
    ? { area: sp.assign.trim().slice(0, 200), suggested: typeof sp.suggest === "string" ? sp.suggest.split(",").filter(Boolean) : [] }
    : null;

  const [proj, setProj] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [proposals, setProposals] = useState<GoalProposal[]>([]);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [workspace, setWorkspace] = useState("");

  useEffect(() => {
    api.me()
      .then((m) => {
        setViewer({
          admin: !!m.admin || !m.auth,
          me: m.member || m.user?.email || (!m.auth ? localStorage.getItem("reins-me") : "") || "",
          auth: m.auth,
        });
        setWorkspace(m.workspace?.name || "");
      })
      .catch((e) => { if (!handleAuth(e)) setViewer({ admin: false, me: "", auth: true }); });
  }, []);

  const load = useCallback(async () => {
    try {
      setProj(await api.project(id));
      setMissing(false);
      setLoadErr("");
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setLoadErr(errorMessage(e));
    }
  }, [id]);

  const loadGoals = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([api.goals(id), api.goalProposals(id)]);
      setGoals(g.goals);
      setProposals(p.proposals);
    } catch (e) { handleAuth(e); }
  }, [id]);

  const onChange = useCallback(() => { load(); loadGoals(); }, [load, loadGoals]);
  useEffect(() => { load(); loadGoals(); }, [load, loadGoals]);
  const live = useStream(id, onChange);

  const name = proj?.name || id;
  useEffect(() => { document.title = `Lead · ${name} · Reins`; }, [name]);
  const nameOf = (m: string) => proj?.members.find((x) => x.member === m)?.displayName || m;
  const enc = encodeURIComponent(id);
  const meInProject = !!viewer?.me && !!proj?.members.some((m) => m.member === viewer.me);

  return (
    <div className="ld">
      <header className="ld-head">
        <div className="ld-head-l">
          <Link href="/dashboard" className="ld-logo" aria-label="Reins projects"><Mark size={36} /></Link>
          <nav aria-label="Breadcrumb" className="ld-crumbs">
            <ol>
              {workspace && <li className="ld-crumb-ws"><Link href="/dashboard">{workspace}</Link></li>}
              <li className="ld-crumb-proj"><Link href={`/project/${enc}`}>{name}</Link></li>
              <li className="ld-crumb-cur" aria-current="page">Lead</li>
            </ol>
          </nav>
        </div>
        <div className="ld-head-r">
          <span className="ld-livechip" role="status">
            <span className={`rz-live${live ? "" : " away"}`} aria-hidden="true" />
            {live ? "live" : "offline"}
          </span>
          <Link href={`/project/${enc}`} className="ld-lanes">Lanes</Link>
          <UserMenu />
        </div>
      </header>

      <main className="ld-body">
        {missing ? (
          <p className="ld-msg">No project “{id}”. <Link href="/dashboard">Back to projects</Link></p>
        ) : !proj || !viewer ? (
          loadErr ? (
            <p className="ld-msg">
              Could not load “{id}”: {loadErr}{" "}
              <button type="button" className="ld-ghost" onClick={load}>Retry</button>
            </p>
          ) : <p className="ld-msg">Loading…</p>
        ) : (
          <>
            <DirectiveBand proj={proj} admin={viewer.admin} onChange={load} />
            <div className="ld-grid">
              {loadErr && <p className="ld-err ld-wide" role="alert">Could not refresh: {loadErr}</p>}
              <Goals projectId={proj.id} goals={goals} viewer={viewer} nameOf={nameOf} onChange={loadGoals} />
              <div className="ld-col">
                <Proposals proposals={proposals} admin={viewer.admin} nameOf={nameOf} onChange={loadGoals} />
                <Assignments proj={proj} admin={viewer.admin} prefill={prefill} onChange={load} />
              </div>
            </div>
          </>
        )}
      </main>

      <ProjectTabs projectId={id} me={meInProject ? viewer!.me : null} current="lead" lead={!!viewer?.admin} />
    </div>
  );
}
