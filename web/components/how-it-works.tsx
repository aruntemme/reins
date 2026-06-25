"use client";
import { useState } from "react";
import { Reveal } from "./reveal";

/**
 * "How it works": a small loop diagram. Boxes on a clean baseline
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
      "A small hook reads what your agent already writes, every prompt and every turn, and sends it to Reins. There's nothing for you to log.",
  },
  {
    id: "dashboard",
    dot: "blue",
    name: "Dashboard",
    blurb:
      "Reins turns that stream into a simple board: who's doing what, what's blocked, and what's free to pick up. Not a pile of logs.",
  },
  {
    id: "mcp",
    dot: "active",
    name: "MCP",
    blurb:
      "Any agent can ask Reins for the current context, scoped to a person and a question, so everyone reads from the same place.",
  },
];

export function HowItWorks() {
  const [mode, setMode] = useState<Mode>("overview");

  return (
    <section id="how" className="lsection alt">
      <div className="wrap">
        <Reveal as="h2" className="lsection-title" text="See how the pieces fit." />
        <p className="sub lsection-lead">
          Three small parts, one loop. Pick one to see what it does, and watch that path light up.
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

/* ── diagram (boxes + flowing packets) ───────────────────────────────────── */

function Diagram({ mode, onPick }: { mode: Mode; onPick: (m: Mode) => void }) {
  return (
    <svg
      className="hiw-svg"
      data-focus={mode}
      viewBox="0 0 1040 400"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Agent activity flows through a hook into Reins, out to the dashboard, and back to any agent over MCP."
    >
      <defs>
        <marker id="hiw-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="hiw-arrowhead" />
        </marker>
      </defs>

      {/* wires (static) — referenced by packets via mpath */}
      <path id="wCap" className="hiw-wire wire-cap" d="M 224 150 H 512" markerEnd="url(#hiw-arrow)" />
      <path id="wDash" className="hiw-wire wire-dash" d="M 724 150 H 812" markerEnd="url(#hiw-arrow)" />
      <path id="wMcp" className="hiw-wire wire-mcp" d="M 618 236 C 618 360, 330 372, 136 208" markerEnd="url(#hiw-arrow)" />

      {/* packets */}
      <Packets pathId="wCap" cls="pkt-cap" n={3} dur={2.4} />
      <Packets pathId="wDash" cls="pkt-dash" n={2} dur={1.5} />
      <Packets pathId="wMcp" cls="pkt-mcp" n={3} dur={3.0} />

      {/* nodes */}
      <Node x={48} y={90} w={176} h={116} cls="node-agent" kicker="your editor" title="agent" sub="Claude Code, Codex, …" />
      <Node x={296} y={107} w={140} h={88} cls="node-hook" kicker="capture" title="hook" sub="reads each turn" onClick={() => onPick("hooks")} />
      <Node x={512} y={64} w={212} h={172} cls="node-reins" kicker="distill" title="reins" sub="triage · extract · rollup" big />
      <Node x={812} y={82} w={184} h={140} cls="node-dash" kicker="glance" title="dashboard" sub="status · pending · risks" onClick={() => onPick("dashboard")} />
      <Node x={512} y={300} w={212} h={84} cls="node-mcp" kicker="read back" title="mcp" sub="shared context, on demand" onClick={() => onPick("mcp")} />
    </svg>
  );
}

function Packets({ pathId, cls, n, dur }: { pathId: string; cls: string; n: number; dur: number }) {
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <rect key={i} className={`hiw-pkt ${cls}`} x={-6} y={-6} width={11} height={11} rx={3}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${(dur / n) * i}s`} rotate="auto">
            <mpath xlinkHref={`#${pathId}`} />
          </animateMotion>
        </rect>
      ))}
    </>
  );
}

function Node({
  x, y, w, h, cls, kicker, title, sub, big, onClick,
}: {
  x: number; y: number; w: number; h: number; cls: string;
  kicker: string; title: string; sub: string; big?: boolean; onClick?: () => void;
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
      <rect className="hiw-node-box" x={0} y={0} width={w} height={h} rx={14} />
      <text className="hiw-kicker" x={16} y={26}>{kicker}</text>
      <text className="hiw-title" x={16} y={big ? 64 : 56}>{title}</text>
      <text className="hiw-sub" x={16} y={big ? 90 : 78}>{sub}</text>
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
