"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Hero product demo: two teammates' agents (different vendors) and the Reins
 * team state between them. Plays a short script where dev's agent is warned
 * about maya's in-flight edit before it touches the same file, a handoff opens,
 * and then closes itself when maya's agent ships the change.
 *
 * Every line is always rendered (hidden ones are transparent), so the frame
 * never changes size while it plays: no layout shift. Reduced motion shows the
 * finished state with no timers. Playback pauses when off screen.
 */

type Kind = "prompt" | "tool" | "say" | "reins" | "warn" | "ok";
type Line = { at: number; kind: Kind; text: string; file?: string; meta?: string };
type Event = { at: number; tone: "member" | "warn" | "handoff" | "ok"; title: string; detail: string };

const MAYA: Line[] = [
  { at: 1, kind: "prompt", text: "make token refresh retry once before logging out" },
  { at: 2, kind: "tool", text: "Read", file: "src/auth/session.ts" },
  { at: 3, kind: "tool", text: "Edit", file: "src/auth/session.ts", meta: "+38 -12" },
  { at: 9, kind: "reins", text: "Handoff from dev: expose an onRefresh hook for remember-me." },
  { at: 10, kind: "tool", text: "Edit", file: "src/auth/session.ts", meta: "+9" },
  { at: 11, kind: "ok", text: "onRefresh hook added. Handoff closed." },
];

const DEV: Line[] = [
  { at: 4, kind: "reins", text: "Team briefing: maya is refactoring token refresh in src/auth/session.ts." },
  { at: 5, kind: "prompt", text: "add a remember-me checkbox to login" },
  { at: 6, kind: "say", text: "Plan: edit src/pages/login.tsx, then src/auth/session.ts." },
  { at: 7, kind: "warn", text: "maya is editing src/auth/session.ts right now. Heads up, not a block." },
  { at: 8, kind: "say", text: "Starting with login.tsx. Leaving maya a handoff for the session hook." },
  { at: 12, kind: "reins", text: "Handoff closed: onRefresh is ready in session.ts." },
  { at: 13, kind: "tool", text: "Edit", file: "src/auth/session.ts", meta: "+4" },
];

const EVENTS: Event[] = [
  { at: 3, tone: "member", title: "maya is refactoring token refresh", detail: "src/auth/session.ts on maya/token-refresh" },
  { at: 6, tone: "member", title: "dev is adding remember-me", detail: "plans to touch src/auth/session.ts" },
  { at: 7, tone: "warn", title: "Overlap caught before the edit", detail: "dev's agent warned about session.ts" },
  { at: 8, tone: "handoff", title: "Handoff opened: dev → maya", detail: "needs an onRefresh hook" },
  { at: 11, tone: "ok", title: "Handoff closed itself", detail: "maya's agent shipped the hook" },
];

const LAST = 13;
const STEP_MS = 1150;
const HOLD_MS = 4800;

const GLYPH: Record<Kind, string> = { prompt: ">", tool: "●", say: "●", reins: "◆", warn: "▲", ok: "✓" };

function Pane({ who, agent, branch, lines, step }: { who: string; agent: string; branch: string; lines: Line[]; step: number }) {
  return (
    <div className="rl-pane">
      <div className="rl-pane-head">
        <span className="rl-pane-who">{who}</span>
        <span className="rl-pane-agent">{agent}</span>
        <span className="rl-pane-branch">{branch}</span>
      </div>
      <ol className="rl-pane-body">
        {lines.map((l, i) => (
          <li
            key={i}
            className={`rl-ln rl-ln-${l.kind}${step >= l.at ? " is-on" : ""}${step === l.at ? " is-new" : ""}`}
          >
            <span className="rl-ln-g">{GLYPH[l.kind]}</span>
            <span className="rl-ln-t">
              {l.kind === "reins" || l.kind === "warn" ? <b>reins </b> : null}
              {l.kind === "tool" ? <b>{l.text}</b> : l.text}
              {l.file ? <> <code>{l.file}</code></> : null}
              {l.meta ? <span className="rl-ln-meta"> {l.meta}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function LandingDemo() {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Reduced motion: jump to the finished state and never animate.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) setStep(LAST);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Only play while the frame is on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || paused || !visible) return;
    const t = window.setTimeout(
      () => setStep((s) => (s >= LAST ? 0 : s + 1)),
      step >= LAST ? HOLD_MS : step === 0 ? 700 : STEP_MS
    );
    return () => window.clearTimeout(t);
  }, [step, paused, visible, reduced]);

  return (
    <figure ref={ref} className="rl-demo" aria-labelledby="rl-demo-cap">
      <figcaption id="rl-demo-cap" className="rl-sr">
        Example: maya&rsquo;s Claude Code agent is editing src/auth/session.ts. When dev&rsquo;s Codex agent
        plans to edit the same file, Reins briefs it and warns it first without blocking. Dev&rsquo;s agent
        starts elsewhere and opens a handoff, which closes itself once maya&rsquo;s agent ships the change.
      </figcaption>

      <div className="rl-demo-bar">
        <span className="rl-demo-proj">
          <span className="rl-live" aria-hidden="true" /> checkout-v2
        </span>
        <span className="rl-demo-meta">2 people, 2 agents, 1 shared context</span>
        {!reduced && (
          <button
            type="button"
            className="rl-demo-toggle"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? "Play" : "Pause"}
            <span className="rl-sr"> the demo animation</span>
          </button>
        )}
      </div>

      <div className="rl-demo-grid" aria-hidden="true">
        <Pane who="maya" agent="Claude Code" branch="maya/token-refresh" lines={MAYA} step={step} />

        <div className="rl-rail">
          <div className="rl-rail-head">
            <span className="rl-rail-mark">reins</span> team state
          </div>
          <ol className="rl-rail-list">
            {EVENTS.map((e, i) => (
              <li
                key={i}
                className={`rl-ev rl-ev-${e.tone}${step >= e.at ? " is-on" : ""}${step === e.at ? " is-new" : ""}`}
              >
                <span className="rl-ev-title">{e.title}</span>
                <span className="rl-ev-detail">{e.detail}</span>
              </li>
            ))}
          </ol>
        </div>

        <Pane who="dev" agent="Codex" branch="dev/remember-me" lines={DEV} step={step} />
      </div>
    </figure>
  );
}
