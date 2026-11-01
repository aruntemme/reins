"use client";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, ApiError, errorMessage, installCommand, type Me, type Member, type Project } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { Mark } from "@/components/ui";
import { CopyCommand } from "@/components/copy-command";
import "./connect.css";

const POLL_MS = 5000;

// What the project already had when this page opened, so only new activity counts as "connected".
interface Baseline { at: number; seen: Record<string, number> }
const newestOf = (m: Member) => Math.max(m.lastSeen ?? 0, m.timeline[0]?.at ?? 0, m.touches[0]?.at ?? 0);
const baselineOf = (p: Project): Baseline => ({
  at: Math.max(0, ...p.members.map(newestOf)),
  seen: Object.fromEntries(p.members.map((m) => [m.member, newestOf(m)])),
});

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });

interface LogLine { at: number; text: string }

export default function Connect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [me, setMe] = useState<Me | null>(null);
  const [meDone, setMeDone] = useState(false);
  const [origin, setOrigin] = useState("");
  const [proj, setProj] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [base, setBase] = useState<Baseline | null>(null);
  const [connected, setConnected] = useState<{ member: string; at: number } | null>(null);
  const [streamLine, setStreamLine] = useState<LogLine | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    api.me().then(setMe).catch(() => {}).finally(() => setMeDone(true));
  }, [id]);

  const load = useCallback(async () => {
    try {
      const p = await api.project(id);
      setProj(p);
      setMissing(false);
      setLoadErr("");
      setBase((b) => b ?? baselineOf(p));
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setLoadErr(errorMessage(e));
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  const live = useStream(id, load);

  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [connected, load]);

  useEffect(() => {
    if (live) setStreamLine({ at: Date.now(), text: "server reachable · live stream open" });
  }, [live]);

  // Who counts as "you": the capture identity the wizard stored for this account, or the account email.
  const identity = me?.member || me?.user?.email || null;
  const mine = useMemo(() => {
    const ids = [me?.member, me?.user?.email].filter((v): v is string => !!v).map((v) => v.toLowerCase());
    return (member: string) => ids.length === 0 || ids.includes(member.toLowerCase());
  }, [me]);

  // Connected = a member that is you appears, or checks in again, after this page loaded. With no
  // account identity (auth off) any new activity counts, as nobody can be told apart.
  useEffect(() => {
    if (!proj || !base || !meDone || connected) return;
    const hit = proj.members.find((m) => mine(m.member) && (!(m.member in base.seen) || newestOf(m) > base.seen[m.member]));
    if (hit) setConnected({ member: hit.member, at: newestOf(hit) });
  }, [proj, base, meDone, mine, connected]);

  const command = origin ? `npx reins-hook --url ${origin} --project ${id}` : null;
  // The non-interactive form for CI; the token placeholder is for an admin to fill in.
  const ciCommand = origin
    ? installCommand({ url: origin, project: id, token: "YOUR_INGEST_TOKEN" }).replace("reins-hook install", "reins-hook install --agent claude-code")
    : null;
  const showApproval = me?.auth !== false;

  const display = useMemo(() => command && (
    <span className="cn-cmd"><span className="cn-prompt">$</span> {command}</span>
  ), [command]);

  const log = useMemo<LogLine[]>(() => {
    const lines: LogLine[] = [];
    if (streamLine) lines.push(streamLine);
    if (proj && base) {
      for (const m of proj.members) {
        const fresh = m.timeline.some((t) => t.at > base.at) || m.touches.some((t) => t.at > base.at);
        if (m.lastSeen > base.at && !fresh) lines.push({ at: m.lastSeen, text: `${m.member in base.seen ? "checked in" : "agent connected"} · ${m.member}` });
        for (const t of m.timeline) if (t.at > base.at) lines.push({ at: t.at, text: `${t.kind} · ${m.member} · ${t.summary}` });
        for (const t of m.touches) if (t.at > base.at) lines.push({ at: t.at, text: `edit seen · ${m.member} · ${t.path}` });
      }
    }
    return lines.sort((a, b) => a.at - b.at).slice(-5);
  }, [proj, base, streamLine]);

  const projectHref = `/project/${encodeURIComponent(id)}`;
  const who = connected ? (identity && connected.member.toLowerCase() === identity.toLowerCase() ? "you" : connected.member) : "";

  if (missing) {
    return (
      <div className="cn-missing">
        <Mark size={32} />
        <h1>Project not found.</h1>
        <p>There is no project called <code>{id}</code> in this workspace.</p>
        <Link href="/dashboard" className="rz-btn primary">Back to projects</Link>
      </div>
    );
  }

  return (
    <main className="cn">
      <header className="cn-head">
        <Link href="/dashboard" className="cn-brand"><Mark />reins</Link>
        <span className="cn-where">
          {me?.workspace ? `${me.workspace.name} · ` : ""}<b>{proj?.name || id}</b>
        </span>
      </header>

      <div className="cn-intro">
        <p className="rz-eyebrow">Step 2 of 3</p>
        <h1>Connect your agent.</h1>
        <p>Run one command in your repo. A short wizard sets up the coding agents you already use; you keep working exactly as before.</p>
      </div>

      <div className="cn-term">
        <div className="cn-term-head">in your repo · nothing secret in this command</div>
        {command && display ? (
          <CopyCommand block text={command} display={display} />
        ) : (
          <div className="cn-term-wait" aria-busy="true">Preparing your command…</div>
        )}
      </div>

      <ol className="cn-wiz" aria-label="What the wizard does">
        <li>Detects your coding agents (Claude Code, Codex, OpenCode, Aider).</li>
        {showApproval && <li>Opens your browser so you can approve this terminal. Your credentials stay in <code>~/.reins</code>, not in your repo.</li>}
        <li>Writes each agent&rsquo;s config for you.</li>
        <li>Says hello to the board, and this page turns green.</li>
      </ol>

      <div className="cn-notes">
        <details className="cn-ci">
          <summary>Prefer flags? (CI)</summary>
          <p>
            Skip the wizard and pass everything as flags. An owner or admin can create an ingest token under
            &ldquo;Manage tokens&rdquo; on the project page; swap it in for <code>YOUR_INGEST_TOKEN</code>. Other agents:
            {" "}<code>--agent codex|opencode|aider</code>.
          </p>
          {ciCommand ? <CopyCommand block text={ciCommand} /> : null}
        </details>
        {loadErr && !proj && <p className="cn-warn" role="alert">Could not reach the project: {loadErr}</p>}
      </div>

      <aside className={`cn-right rz-field${connected ? " ok" : ""}`} aria-label="Live connection">
        <span className="rz-blob cn-blob" aria-hidden="true" />
        <div className="cn-anchor" aria-hidden="true">
          <span className="cn-ring" /><span className="cn-ring" /><span className="cn-ring" />
          <span className="cn-dash a" /><span className="cn-dash b" />
          <div className="cn-core rz-glass"><Mark tone="plain" size={40} /></div>
          <div className="cn-orbit">
            <div className="cn-counter">
              {connected ? (
                <div className="cn-chip on">
                  <span className="cn-chip-ic">✓</span>
                  <span className="cn-chip-t">{who}</span>
                  <span className="cn-chip-s">connected</span>
                </div>
              ) : (
                <div className="cn-chip wait">
                  <span className="cn-chip-ic" />
                  <span className="cn-chip-t">your agent</span>
                </div>
              )}
            </div>
            <div className="cn-slot">
              <span className="cn-chip wait">
                <span className="cn-chip-ic" />
                <span className="cn-chip-t">teammate slot</span>
              </span>
            </div>
          </div>
        </div>

        <div className="cn-status">
          <p role="status" className="cn-status-t">
            {connected ? (
              <>Connected. {who === "you" ? "You" : who} checked in.</>
            ) : (
              <>
                Waiting for your terminal
                <span className="cn-dots" aria-hidden="true"><i /><i /><i /></span>
              </>
            )}
          </p>
          <div className="cn-log" role="log" aria-label="Recent events">
            {log.length === 0 ? (
              <div className="cn-log-empty">{live ? "Waiting for your terminal to check in." : "Connecting to the live stream…"}</div>
            ) : (
              log.map((l) => (
                <div key={`${l.at}-${l.text}`} className="cn-log-line">
                  <span className="cn-log-t">{clock(l.at)}</span> {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      </aside>

      <nav className="cn-nav" aria-label="Setup progress">
        <ol className="cn-steps">
          <li className="done"><span className="cn-num">✓</span><span className="cn-lbl">Workspace created</span></li>
          <li className="cur" aria-current="step"><span className="cn-num">2</span><span className="cn-lbl">Connect your agent</span></li>
          <li><span className="cn-num">3</span><span className="cn-lbl"><Link href={projectHref}>Invite the team</Link></span></li>
        </ol>
        <div className="cn-go">
          {!connected && <Link href={projectHref} className="cn-skip">Skip<span className="cn-skip-long"> for now</span></Link>}
          <Link href={projectHref} className="rz-btn primary cn-continue">Continue</Link>
        </div>
      </nav>
    </main>
  );
}
