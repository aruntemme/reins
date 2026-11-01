import Link from "next/link";

/** The phone bottom bar shared by the project's Lanes, Brief and Lead pages (hidden on desktop). */
export function ProjectTabs({
  projectId,
  me,
  current,
  lead,
}: {
  projectId: string;
  /** The viewer's member id when they are on this project; adds the Brief tab. */
  me?: string | null;
  /** The tab for this page; none on a teammate's member page. */
  current?: "lanes" | "brief" | "lead";
  /** Leads see "Lead"; everyone else reaches the same page for their goals. */
  lead: boolean;
}) {
  const enc = encodeURIComponent(projectId);
  const at = (tab: "lanes" | "brief" | "lead") => (tab === current ? ("page" as const) : undefined);
  return (
    <>
      <div className="rz-tabs-space" aria-hidden="true" />
      <nav className="rz-tabs" aria-label="Project">
        <Link href={`/project/${enc}`} aria-current={at("lanes")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M4 12h16M4 17h7" /></svg>
          Lanes
        </Link>
        {me && (
          <Link href={`/project/${enc}/${encodeURIComponent(me)}`} aria-current={at("brief")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M9 9h6M9 13h6M9 17h3" /></svg>
            Brief
          </Link>
        )}
        <Link href={`/project/${enc}/lead`} aria-current={at("lead")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 11v2a1 1 0 0 0 1 1h2l5 4V6L7 10H5a1 1 0 0 0-1 1z" /><path d="M16 9a4 4 0 0 1 0 6" /></svg>
          {lead ? "Lead" : "Goals"}
        </Link>
      </nav>
    </>
  );
}
