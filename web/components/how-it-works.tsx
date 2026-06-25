"use client";
import { useState } from "react";
import { Reveal } from "./reveal";

/**
 * "How it works" — a refined loop diagram. Four nodes on a clean baseline
 * (agent → hook → reins → dashboard) with gradient, animated connectors, and an
 * elegant MCP return arc that carries shared context back to the agent. Picking
 * Hooks / Dashboard / MCP focuses that path (the rest dims) and swaps a big
 * detail panel with a live mini-simulation of that piece. Honors
 * prefers-reduced-motion in CSS.
 */

type Mode = "overview" | "hooks" | "dashboard" | "mcp";

const STAGES: { id: Exclude<Mode, "overview">; dot: string; name: string; blurb: string }[] = [
  {
    id: "hooks",
    dot: "",
    name: "Hooks",
    blurb:
      "A tiny hook reads what your coding agent already emits — every prompt and every turn — and streams it to Reins. Nothing to write, no step added to your flow.",
  },
  {
    id: "dashboard",
    dot: "blue",
    name: "Dashboard",
    blurb:
      "Reins distills the raw stream into a live board: each teammate's headline and status, what's pending, the handoffs, and the risks worth a glance — not a pile of logs.",
  },
  {
    id: "mcp",
    dot: "active",
    name: "MCP",
    blurb:
      "Any agent pulls the current shared context back over MCP — scoped to the member and question — so everyone reads from the same place instead of guessing.",
  },
];

export function HowItWorks() {
  const [mode, setMode] = useState<Mode>("overview");

  return (
    <section id="how" className="lsection alt">
      <div className="wrap">
        <Reveal as="h2" className="lsection-title" text="See how the pieces fit." />
        <p className="sub lsection-lead">
          Three moving parts, one loop. Pick a piece to watch just that path light up — and see what
          it actually does.
        </p>

        <div className="hiw-chips" role="tablist" aria-label="How it works">
          <button
            role="tab"
            aria-selected={mode === "overview"}
            className={`hiw-chip ${mode === "overview" ? "on" : ""}`}
            onClick={() => setMode("overview")}
          >
            overview
          </button>
          {STAGES.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={mode === s.id}
              className={`hiw-chip on-${s.id} ${mode === s.id ? "on" : ""}`}
              onClick={() => setMode(s.id)}
            >
              <span className={`sq ${s.dot}`} /> {s.name}
            </button>
          ))}
        </div>

        <div className="hiw-stage card">
          <Diagram mode={mode} onPick={setMode} />
        </div>

        <div className="hiw-panel" key={mode}>
          {mode === "overview" ? <OverviewPanel onPick={setMode} /> : <FocusPanel mode={mode} />}
        </div>
      </div>
    </section>
  );
}

/* ── diagram ─────────────────────────────────────────────────────────────── */

function Diagram({ mode, onPick }: { mode: Mode; onPick: (m: Mode) => void }) {
  return (
    <svg
      className="hiw-svg"
      data-focus={mode}
      viewBox="0 0 1040 300"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Agent activity flows through a hook into Reins and out to the dashboard; any agent reads the shared context back over MCP."
    >
      <defs>
        <marker id="hiw-tip" viewBox="0 0 10 10" refX="7.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9" className="hiw-tip" />
        </marker>
        <linearGradient id="gCap" gradientUnits="userSpaceOnUse" x1="220" y1="0" x2="286" y2="0">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.15" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id="gCap2" gradientUnits="userSpaceOnUse" x1="456" y1="0" x2="522" y2="0">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.15" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id="gDash" gradientUnits="userSpaceOnUse" x1="712" y1="0" x2="778" y2="0">
          <stop offset="0" stopColor="var(--blue)" stopOpacity="0.15" />
          <stop offset="1" stopColor="var(--blue)" />
        </linearGradient>
        <linearGradient id="gMcp" gradientUnits="userSpaceOnUse" x1="617" y1="156" x2="125" y2="156">
          <stop offset="0" stopColor="var(--active)" stopOpacity="0.12" />
          <stop offset="1" stopColor="var(--active)" />
        </linearGradient>
      </defs>

      {/* MCP return arc (drawn first, behind the row) */}
      <g className="grp-mcp">
        <path id="aMcp" className="hiw-arc-base" d="M 617 156 C 617 252, 125 252, 125 156" />
        <path className="hiw-arc-flow" d="M 617 156 C 617 252, 125 252, 125 156" stroke="url(#gMcp)" markerEnd="url(#hiw-tip)" />
        <Dot pathId="aMcp" cls="dot-mcp" dur={3.2} />
        <g
          className="hiw-arc-label pick"
          transform="translate(371 244)"
          onClick={() => onPick("mcp")}
          tabIndex={0}
          role="button"
          aria-label="MCP: read shared context back"
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick("mcp"); } }}
        >
          <rect x={-44} y={-15} width={88} height={30} rx={15} />
          <text x={2} y={5} textAnchor="middle">mcp · read back</text>
        </g>
      </g>

      {/* straight connectors */}
      <Wire id="wCap" cls="cap" grad="url(#gCap)" d="M 220 100 H 286" dur={2.0} />
      <Wire id="wCap2" cls="cap" grad="url(#gCap2)" d="M 456 100 H 522" dur={2.0} delay={0.5} />
      <Wire id="wDash" cls="dash" grad="url(#gDash)" d="M 712 100 H 778" dur={1.5} />

      {/* nodes */}
      <Node x={30} y={44} w={190} h={112} cls="node-agent" icon="agent" kicker="your editor" title="agent" sub="Claude Code, Codex, …" />
      <Node x={286} y={44} w={170} h={112} cls="node-hook" icon="hook" kicker="capture" title="hook" sub="reads each turn" onClick={() => onPick("hooks")} />
      <Node x={522} y={44} w={190} h={112} cls="node-reins" icon="reins" kicker="distill" title="reins" sub="triage · extract · rollup" accent />
      <Node x={778} y={44} w={190} h={112} cls="node-dash" icon="dash" kicker="glance" title="dashboard" sub="status · pending · risks" onClick={() => onPick("dashboard")} />
    </svg>
  );
}

function Wire({ id, cls, grad, d, dur, delay = 0 }: { id: string; cls: string; grad: string; d: string; dur: number; delay?: number }) {
  return (
    <g className={`grp-${cls === "dash" ? "dash" : "cap"}`}>
      <path className="hiw-wire-base" d={d} />
      <path id={id} className={`hiw-wire-flow wire-${cls}`} d={d} stroke={grad} markerEnd="url(#hiw-tip)" />
      <Dot pathId={id} cls={`dot-${cls}`} dur={dur} delay={delay} />
    </g>
  );
}

function Dot({ pathId, cls, dur, delay = 0 }: { pathId: string; cls: string; dur: number; delay?: number }) {
  return (
    <circle className={`hiw-dot ${cls}`} r={4.5} cx={0} cy={0}>
      <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${delay}s`}>
        <mpath xlinkHref={`#${pathId}`} />
      </animateMotion>
    </circle>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  // 20×20 line glyphs, stroke = currentColor
  agent: <path d="M3 4 L9 10 L3 16 M11 16 H17" />,
  hook: <path d="M10 3 V11 A4 4 0 1 1 6 7" />,
  reins: <path d="M10 2 L13.5 10 L10 18 L6.5 10 Z" />,
  dash: <path d="M3 3 H9 V9 H3 Z M11 3 H17 V9 H11 Z M3 11 H9 V17 H3 Z M11 11 H17 V17 H11 Z" />,
};

function Node({
  x, y, w, h, cls, icon, kicker, title, sub, accent, onClick,
}: {
  x: number; y: number; w: number; h: number; cls: string;
  icon: string; kicker: string; title: string; sub: string; accent?: boolean; onClick?: () => void;
}) {
  return (
    <g
      className={`hiw-node ${cls} ${onClick ? "pick" : ""}`}
      transform={`translate(${x} ${y})`}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? "button" : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <rect className="hiw-node-box" x={0} y={0} width={w} height={h} rx={16} />
      <g className="hiw-ico" transform="translate(18 18)">{ICONS[icon]}</g>
      <text className="hiw-kicker" x={46} y={32}>{kicker}</text>
      <text className={`hiw-title ${accent ? "big" : ""}`} x={18} y={74}>{title}</text>
      <text className="hiw-sub" x={18} y={96}>{sub}</text>
    </g>
  );
}

/* ── panels ──────────────────────────────────────────────────────────────── */

function OverviewPanel({ onPick }: { onPick: (m: Exclude<Mode, "overview">) => void }) {
  return (
    <div className="hiw-over">
      {STAGES.map((s) => (
        <button key={s.id} className={`hiw-over-card on-${s.id}`} onClick={() => onPick(s.id)}>
          <div className="label"><span className={`sq ${s.dot}`} /> {s.name}</div>
          <p>{s.blurb}</p>
          <span className="hiw-over-go mono">see how →</span>
        </button>
      ))}
    </div>
  );
}

function FocusPanel({ mode }: { mode: Exclude<Mode, "overview"> }) {
  const stage = STAGES.find((s) => s.id === mode)!;
  return (
    <div className={`hiw-focus focus-${mode}`}>
      <div className="hiw-focus-copy">
        <div className="label"><span className={`sq ${stage.dot}`} /> {stage.name}</div>
        <p>{stage.blurb}</p>
      </div>
      <div className="hiw-focus-sim">
        {mode === "hooks" && <HooksSim />}
        {mode === "dashboard" && <DashboardSim />}
        {mode === "mcp" && <McpSim />}
      </div>
    </div>
  );
}

function HooksSim() {
  const events: [string, string, string][] = [
    ["prompt", "", "add password reset routes"],
    ["edit", "f-edit", "routes/auth.ts  + reset"],
    ["run", "f-run", "npm test  ·  48 passed"],
    ["commit", "f-commit", "auth: one-time reset links"],
  ];
  return (
    <div className="card hiw-sim">
      <div className="hiw-sim-head"><span className="sq active live-dot" /> capturing · agent activity</div>
      <div className="hiw-stream">
        {events.map(([tag, mod, text], i) => (
          <div className="hiw-ev" style={{ animationDelay: `${0.15 + i * 0.5}s` }} key={i}>
            <span className={`hiw-ev-tag ${mod}`}>{tag}</span>
            <span className="hiw-ev-text">{text}</span>
          </div>
        ))}
      </div>
      <pre className="hiw-code mono">npx reins-hook install --me you</pre>
    </div>
  );
}

function DashboardSim() {
  const rows: [string, string, string, number][] = [
    ["active", "asha", "shipping auth routes", 78],
    ["blocked", "ravi", "blocked on schema merge", 40],
    ["idle", "mei", "wrapped up the digest job", 100],
  ];
  return (
    <div className="card hiw-sim">
      <div className="hiw-sim-head"><span className="sq blue" /> team · live board</div>
      <div className="hiw-board">
        {rows.map(([st, who, head, pct], i) => (
          <div className="hiw-brow" style={{ animationDelay: `${0.12 + i * 0.22}s` }} key={who}>
            <span className={`sq ${st}`} />
            <span className="hiw-bwho">{who}</span>
            <span className="hiw-bhead">{head}</span>
            <span className="hiw-bbar"><i style={{ width: `${pct}%`, animationDelay: `${0.3 + i * 0.22}s` }} /></span>
          </div>
        ))}
      </div>
      <div className="hiw-rollup mono">rollup · 1 collision (auth.ts) · 1 risk</div>
    </div>
  );
}

function McpSim() {
  return (
    <div className="card hiw-sim">
      <div className="hiw-sim-head"><span className="sq active" /> mcp · shared context</div>
      <pre className="hiw-code mono hiw-req">→ reins_context(member: "asha", q: "auth")</pre>
      <div className="hiw-resp">
        <div className="hiw-resp-row" style={{ animationDelay: ".25s" }}><b>headline</b> shipping password reset</div>
        <div className="hiw-resp-row" style={{ animationDelay: ".5s" }}><b>pending</b> wire reset email · token TTL</div>
        <div className="hiw-resp-row" style={{ animationDelay: ".75s" }}><b>handoffs</b> ravi → asha · schema ready</div>
        <div className="hiw-resp-row" style={{ animationDelay: "1s" }}><b>risks</b> both touching auth.ts</div>
      </div>
    </div>
  );
}
