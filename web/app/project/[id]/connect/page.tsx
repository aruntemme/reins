"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, errorMessage, installCommand, type Me, type Member, type Project } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { Mark } from "@/components/ui";
import { CopyCommand } from "@/components/copy-command";
import { connectKey, type ConnectHandoff } from "@/components/project-create";
import "./connect.css";

const AGENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "aider", label: "Aider" },
] as const;
type AgentId = (typeof AGENTS)[number]["id"];

const POLL_MS = 5000;

// What the project already had when this page opened, so only new activity counts as "connected".
interface Baseline { at: number; members: string[] }
const newestOf = (m: Member) => Math.max(m.lastSeen ?? 0, m.timeline[0]?.at ?? 0, m.touches[0]?.at ?? 0);
const baselineOf = (p: Project): Baseline => ({ at: Math.max(0, ...p.members.map(newestOf)), members: p.members.map((m) => m.member) });

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
const mask = (v: string) => (v.length > 8 ? `${v.slice(0, v.indexOf("_", 3) + 1 || 3)}••••••••${v.slice(-4)}` : "••••••••");

interface LogLine { at: number; text: string }

export default function Connect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [agent, setAgent] = useState<AgentId>("claude-code");
  const [me, setMe] = useState<Me | null>(null);
  const [meDone, setMeDone] = useState(false);
  const [origin, setOrigin] = useState("");
  const [proj, setProj] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [base, setBase] = useState<Baseline | null>(null);
  const [connected, setConnected] = useState<{ member: string; at: number } | null>(null);
  const [handoff, setHandoff] = useState<ConnectHandoff | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintErr, setMintErr] = useState("");
  const [streamLine, setStreamLine] = useState<LogLine | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setOrigin(window.location.origin);
    api.me().then(setMe).catch(() => {}).finally(() => setMeDone(true));
    try {
      const raw = sessionStorage.getItem(connectKey(id));
      if (raw) setHandoff(JSON.parse(raw) as ConnectHandoff);
    } catch { /* no handoff: the page offers a new token */ }
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

  // First real activity: a teammate-agent we had not seen, or one whose last event is newer than the baseline.
  useEffect(() => {
    if (!proj || !base || connected) return;
    const hit = proj.members.find((m) => !base.members.includes(m.member) || newestOf(m) > base.at);
    if (hit) setConnected({ member: hit.member, at: newestOf(hit) });
  }, [proj, base, connected]);

  const identity = me?.member || me?.user?.email || null;
  const token = handoff?.ingest ?? null;
  // Minting needs owner/admin (or the auth-off local instance). If me() failed, try anyway.
  const canMint = !me || !me.auth || !!me.admin;
  const needsToken = !me || me.auth;

  const issueToken = async () => {
    setMinting(true); setMintErr("");
    try {
      const r = await api.invite(proj?.name || id, false);
      const next: ConnectHandoff = { ingest: r.ingest };
      setHandoff(next);
      try { sessionStorage.setItem(connectKey(id), JSON.stringify(next)); } catch { /* tab-only convenience */ }
    } catch (e) {
      setMintErr(errorMessage(e));
    }
    setMinting(false);
  };

  const done = () => { try { sessionStorage.removeItem(connectKey(id)); } catch { /* ignore */ } };

  const current = AGENTS.find((a) => a.id === agent) ?? AGENTS[0];
  const ready = !!origin && meDone;
  const command = useMemo(() => {
    if (!ready) return null;
    const cmd = installCommand({ url: origin, me: identity, project: id, token });
    return cmd.replace("reins-hook install", `reins-hook install --agent ${agent}`);
  }, [ready, origin, identity, id, token, agent]);

  // The same command, one flag per line, with the secret masked on screen (the copy is complete).
  const display = useMemo(() => {
    if (!command) return null;
    const [head, ...flags] = command.split(" --");
    return (
      <span className="cn-cmd">
        <span className="cn-prompt">$</span> {head}
        {flags.map((f) => {
          const sp = f.indexOf(" ");
          const name = f.slice(0, sp);
          const val = f.slice(sp + 1);
          return (
            <span key={name} className="cn-flag">
              {" \\"}
              {"\n    --"}{name}{" "}
              <span className={name === "agent" ? "cn-hl" : undefined}>{name === "token" ? mask(val) : val}</span>
            </span>
          );
        })}
      </span>
    );
  }, [command]);

  const log = useMemo<LogLine[]>(() => {
    const lines: LogLine[] = [];
    if (streamLine) lines.push(streamLine);
    if (proj && base) {
      for (const m of proj.members) {
        if (!base.members.includes(m.member) && m.timeline.length === 0 && m.touches.length === 0) {
          lines.push({ at: m.lastSeen, text: `agent connected · ${m.member}` });
        }
        for (const t of m.timeline) if (t.at > base.at) lines.push({ at: t.at, text: `${t.kind} · ${m.member} · ${t.summary}` });
        for (const t of m.touches) if (t.at > base.at) lines.push({ at: t.at, text: `edit seen · ${m.member} · ${t.path}` });
      }
    }
    return lines.sort((a, b) => a.at - b.at).slice(-5);
  }, [proj, base, streamLine]);

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const last = AGENTS.length - 1;
    const to = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    setAgent(AGENTS[to].id);
    tabs.current[to]?.focus();
  };

  const projectHref = `/project/${encodeURIComponent(id)}`;
  const who = connected ? (connected.member === identity ? "you" : connected.member) : "";

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
        <p>Run this once in your repo. Reins hooks into the agent you already use; you keep working exactly as before.</p>
      </div>

      <div className="cn-tabs" role="tablist" aria-label="Your coding agent">
        {AGENTS.map((a, i) => (
          <button
            key={a.id}
            ref={(el) => { tabs.current[i] = el; }}
            type="button"
            role="tab"
            id={`cn-tab-${a.id}`}
            aria-selected={a.id === agent}
            aria-controls="cn-panel"
            tabIndex={a.id === agent ? 0 : -1}
            className="cn-tab"
            onClick={() => setAgent(a.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div id="cn-panel" role="tabpanel" aria-labelledby={`cn-tab-${agent}`} className="cn-term">
        <div className="cn-term-head">in your repo · personal settings, not committed</div>
        {command && display ? (
          <CopyCommand block text={command} display={display} />
        ) : (
          <div className="cn-term-wait" aria-busy="true">Preparing your command…</div>
        )}
      </div>

      <div className="cn-notes">
        {agent === "claude-code" ? (
          <p>Then run <code>/hooks</code> in Claude Code to approve it (or restart).</p>
        ) : (
          <p>
            Then point {current.label}&rsquo;s notify/plugin at the command the installer prints. The exact line is in{" "}
            <a href="https://github.com/aruntemme/reins/blob/main/hooks/README.md" target="_blank" rel="noreferrer">hooks/README.md</a>.
          </p>
        )}
        {ready && needsToken && token && (
          <p>
            This ingest token is shown once and works for the whole workspace. Revoke it any time from &ldquo;manage tokens&rdquo; on the project page.
            {canMint && <> Lost it? <button type="button" className="cn-linkbtn" onClick={issueToken} disabled={minting}>{minting ? "Issuing…" : "Issue a new one"}</button>.</>}
          </p>
        )}
        {ready && needsToken && !token && (
          <p className="cn-warn" role="status">
            {canMint ? (
              <>
                {handoff?.mintErr ? `No ingest token was minted (${handoff.mintErr}). ` : "The command needs an ingest token. "}
                <button type="button" className="cn-linkbtn" onClick={issueToken} disabled={minting}>{minting ? "Issuing…" : "Issue an ingest token"}</button>
                {" "}to add it to the command.
              </>
            ) : (
              <>Minting agent tokens needs the owner or admin role. Ask a workspace owner or admin for an ingest token and add <code>--token &lt;token&gt;</code> to the command.</>
            )}
          </p>
        )}
        {mintErr && <p className="cn-warn" role="alert">Could not issue a token: {mintErr}</p>}
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
                  <span className="cn-chip-t">{who} · {current.label}</span>
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
              <>Connected. First event from {who}.</>
            ) : (
              <>
                Listening for your first event
                <span className="cn-dots" aria-hidden="true"><i /><i /><i /></span>
              </>
            )}
          </p>
          <div className="cn-log" role="log" aria-label="Recent events">
            {log.length === 0 ? (
              <div className="cn-log-empty">{live ? "Waiting for the first event from your agent." : "Connecting to the live stream…"}</div>
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
          <li><span className="cn-num">3</span><span className="cn-lbl"><Link href={projectHref} onClick={done}>Invite the team</Link></span></li>
        </ol>
        <div className="cn-go">
          {!connected && <Link href={projectHref} onClick={done} className="cn-skip">Skip<span className="cn-skip-long"> for now</span></Link>}
          <Link href={projectHref} onClick={done} className="rz-btn primary cn-continue">Continue</Link>
        </div>
      </nav>
    </main>
  );
}
