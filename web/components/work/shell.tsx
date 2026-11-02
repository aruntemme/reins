"use client";
import "@/app/work.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, errorMessage, type Me } from "@/lib/api";
import { handleAuth } from "@/lib/guard";
import { useStream } from "@/lib/useStream";
import { Mark } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";

/** A clock that ticks (for relative times). 0 until mounted, so server and first client render agree. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Load one workspace payload, refetch on every SSE change, bounce to /login when
 * signed out, and tell a missing project (404) apart from a transient failure.
 */
export function useWork<T>(project: string, key: string, fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState("");
  const f = useRef(fetcher);
  f.current = fetcher;

  const load = useCallback(async () => {
    try {
      const d = await f.current();
      setData(d);
      setMissing(false);
      setErr("");
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setErr(errorMessage(e));
    }
  }, []);

  useEffect(() => { setData(null); load(); }, [load, key]);
  const live = useStream(project, load);
  return { data, missing, err, load, live };
}

let meCache: Promise<Me> | null = null;
/** The signed-in account (workspace name, role, capture identity); shared across components. */
export function useViewer(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!meCache) meCache = api.me();
    meCache.then(setMe, (e) => { meCache = null; handleAuth(e); });
  }, []);
  return me;
}

export const isLead = (me: Me | null, role?: string) =>
  role === "owner" || role === "admin" || !!me?.admin || me?.role === "owner" || me?.role === "admin" || (me ? !me.auth : false);

/** Run one write: busy flag, the server's error message, and a refresh on success. */
export function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = useCallback(async (p: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setErr("");
    try {
      await p();
      onDone?.();
      return true;
    } catch (e) {
      if (!handleAuth(e)) setErr(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [onDone]);
  return { busy, err, run, setErr };
}

export type View = "today" | "me" | "week";

export function ViewSwitch({ projectId, view }: { projectId: string; view: View | null }) {
  const enc = encodeURIComponent(projectId);
  const tabs: { v: View; href: string; label: string }[] = [
    { v: "today", href: `/project/${enc}`, label: "Today" },
    { v: "me", href: `/project/${enc}/me`, label: "My day" },
    { v: "week", href: `/project/${enc}/week`, label: "This week" },
  ];
  return (
    <nav aria-label="View" className="w-switch w-desk">
      {tabs.map((t) => (
        <Link key={t.v} href={t.href} aria-current={t.v === view ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}

/** The workspace header: brand, where you are, the view switch, page extras, and the account menu. */
export function WorkHeader({
  projectId,
  projectName,
  view,
  crumbs,
  children,
}: {
  projectId: string;
  projectName: string;
  view: View | null;
  /** Breadcrumb after the project (item and person pages). */
  crumbs?: { label: string; href?: string }[];
  children?: React.ReactNode;
}) {
  const me = useViewer();
  const ws = me?.workspace?.name;
  const enc = encodeURIComponent(projectId);
  return (
    <header className={crumbs ? "w-head has-crumbs" : "w-head"}>
      <Link href="/dashboard" className="w-logo" aria-label="All projects"><Mark size={28} /></Link>
      {crumbs && (
        <Link href={crumbs.length > 1 && crumbs[0].href ? crumbs[0].href : `/project/${enc}`} className="w-back" aria-label="Back">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg>
        </Link>
      )}
      {crumbs ? (
        <nav aria-label="Breadcrumb" className="w-crumbs">
          <ol>
            <li><Link href={`/project/${enc}`}>{projectName}</Link></li>
            {crumbs.map((c, i) => (
              <li key={i} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                {c.href ? <Link href={c.href}>{c.label}</Link> : c.label}
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <span className="w-where">
          {ws && <span className="w-desk-inline">{ws} / </span>}
          <b>{projectName}</b>
        </span>
      )}
      {view !== null && <ViewSwitch projectId={projectId} view={view} />}
      <span className="w-head-r">
        {children}
        <UserMenu />
      </span>
    </header>
  );
}

const TAB_ICONS = {
  today: "M3 11l9-7 9 7M5 10v10h14V10",
  me: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v4l3 2",
  week: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4",
  people: "M9 5.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4M3.5 19a5.5 5.5 0 0 1 11 0M15.5 15.2A4.5 4.5 0 0 1 21 19",
};

/** The phone-only bottom bar: Today · My day · Week · People. */
export function PhoneTabs({ projectId, current }: { projectId: string; current: View | "people" | null }) {
  const enc = encodeURIComponent(projectId);
  const tabs: { k: keyof typeof TAB_ICONS; href: string; label: string }[] = [
    { k: "today", href: `/project/${enc}`, label: "Today" },
    { k: "me", href: `/project/${enc}/me`, label: "My day" },
    { k: "week", href: `/project/${enc}/week`, label: "Week" },
    { k: "people", href: `/project/${enc}#people`, label: "People" },
  ];
  return (
    <>
      <div className="w-tabs-space" aria-hidden="true" />
      <nav className="w-tabs" aria-label="Main">
        {tabs.map((t) => (
          <Link key={t.k} href={t.href} aria-current={t.k === current ? "page" : undefined}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={TAB_ICONS[t.k]} /></svg>
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/** Loading / missing / failed states shared by every workspace page. */
export function PageState({ projectId, missing, err, retry, what = "this project" }: { projectId: string; missing: boolean; err: string; retry: () => void; what?: string }) {
  if (missing) {
    return (
      <main className="w-state">
        <p>We couldn’t find {what}.</p>
        <Link href={what === "this project" ? "/dashboard" : `/project/${encodeURIComponent(projectId)}`} className="w-btn">
          {what === "this project" ? "Back to projects" : "Back to Today"}
        </Link>
      </main>
    );
  }
  if (err) {
    return (
      <main className="w-state" role="alert">
        <p>Couldn’t load {what}: {err}</p>
        <button type="button" className="w-btn" onClick={retry}>Try again</button>
      </main>
    );
  }
  return <main className="w-state" aria-busy="true"><p className="w-quiet">Loading…</p></main>;
}

/** A refresh failure on a page that already has data: shown quietly, the old data stays. */
export function StaleNote({ err, retry }: { err: string; retry: () => void }) {
  if (!err) return null;
  return (
    <p className="w-stale" role="status">
      Couldn’t refresh: {err} <button type="button" className="w-link" onClick={retry}>Try again</button>
    </p>
  );
}
