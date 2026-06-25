"use client";
import { useState } from "react";
import { Reveal } from "./reveal";

/**
 * Interactive "how it works" diagram. A single responsive SVG schematic shows
 * the whole loop — your agent → hook → Reins → dashboard, and any agent reading
 * the shared context back over MCP. By default everything animates together
 * (the overview "overlay"); picking Hooks / Dashboard / MCP focuses that path
 * and dims the rest. Packets ride the wires via SMIL <animateMotion>, so motion
 * stays glued to the curves at any width. Honors prefers-reduced-motion in CSS.
 */

type Mode = "overview" | "hooks" | "dashboard" | "mcp";

const STAGES: {
  id: Exclude<Mode, "overview">;
  dot: string; // square color class
  name: string;
  blurb: string;
  detail: React.ReactNode;
}[] = [
  {
    id: "hooks",
    dot: "",
    name: "Hooks",
    blurb:
      "A tiny hook reads what your coding agent already emits — every prompt and every turn — and streams it to Reins. Nothing to write, no extra step in your flow.",
    detail: (
      <pre className="hiw-code">npx reins-hook install \
  --url https://reins.selfintro.in --me you</pre>
    ),
  },
  {
    id: "dashboard",
    dot: "blue",
    name: "Dashboard",
    blurb:
      "Reins distills the raw stream into a live board: each teammate's headline and status, what's pending, handoffs, and the risks worth a glance — not a pile of logs.",
    detail: (
      <div className="hiw-mini card">
        <div className="hiw-mini-row"><span className="sq active" /> asha · shipping auth routes</div>
        <div className="hiw-mini-row"><span className="sq blocked" /> ravi · blocked on schema</div>
        <div className="hiw-mini-bar"><i style={{ width: "72%" }} /></div>
      </div>
    ),
  },
  {
    id: "mcp",
    dot: "active",
    name: "MCP",
    blurb:
      "Any agent pulls the current shared context back over MCP, scoped to the member and question — so everyone reads from the same place instead of guessing.",
    detail: (
      <pre className="hiw-code">→ reins_context(member: "asha")
← headline, pending, handoffs, risks</pre>
    ),
  },
];

const OVERVIEW = {
  name: "The whole loop",
  blurb:
    "Work flows in from every agent, gets distilled into one shared view, and flows back out to any agent that asks. Pick a piece to see how it works.",
};

export function HowItWorks() {
  const [mode, setMode] = useState<Mode>("overview");
  const active = mode === "overview" ? OVERVIEW : STAGES.find((s) => s.id === mode)!;

  return (
    <section id="how" className="lsection">
      <div className="wrap">
        <Reveal as="h2" className="lsection-title" text="See how the pieces fit." />
        <p className="sub lsection-lead">
          Three moving parts, one loop. Hover the diagram, or pick a piece to watch just that path
          light up.
        </p>

        {/* selector chips */}
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
              className={`hiw-chip ${mode === s.id ? "on" : ""}`}
              onClick={() => setMode(s.id)}
            >
              <span className={`sq ${s.dot}`} /> {s.name}
            </button>
          ))}
        </div>

        <div className="hiw-stage card">
          <Diagram mode={mode} onPick={setMode} />
        </div>

        {/* caption that tracks the selection */}
        <div className="hiw-caption">
          <div className="hiw-cap-text">
            <div className="label">
              <span className={`sq ${mode === "overview" ? "" : active === OVERVIEW ? "" : (active as (typeof STAGES)[number]).dot}`} />
              {active.name}
            </div>
            <p>{active.blurb}</p>
          </div>
          <div className="hiw-cap-detail">
            {mode !== "overview" && (active as (typeof STAGES)[number]).detail}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── the schematic ──────────────────────────────────────────────────────── */

function Diagram({ mode, onPick }: { mode: Mode; onPick: (m: Mode) => void }) {
  return (
    <svg
      className="hiw-svg"
      data-focus={mode}
      viewBox="0 0 1040 500"
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
      <path id="wCap" className="hiw-wire wire-cap" d="M 224 236 H 512" markerEnd="url(#hiw-arrow)" />
      <path id="wDash" className="hiw-wire wire-dash" d="M 724 236 H 812" markerEnd="url(#hiw-arrow)" />
      <path id="wMcp" className="hiw-wire wire-mcp" d="M 618 322 C 618 470, 330 482, 136 294" markerEnd="url(#hiw-arrow)" />

      {/* packets */}
      <Packets pathId="wCap" cls="pkt-cap" n={3} dur={2.4} />
      <Packets pathId="wDash" cls="pkt-dash" n={2} dur={1.5} />
      <Packets pathId="wMcp" cls="pkt-mcp" n={3} dur={3.0} />

      {/* nodes */}
      <Node x={48} y={176} w={176} h={116} cls="node-agent" kicker="your editor" title="agent" sub="Claude Code, Codex, …" />
      <Node x={296} y={193} w={140} h={88} cls="node-hook" kicker="capture" title="hook" sub="reads each turn" onClick={() => onPick("hooks")} />
      <Node x={512} y={150} w={212} h={172} cls="node-reins" kicker="distill" title="reins" sub="triage · extract · rollup" big />
      <Node x={812} y={168} w={184} h={140} cls="node-dash" kicker="glance" title="dashboard" sub="status · pending · risks" onClick={() => onPick("dashboard")} />
      <Node x={512} y={388} w={212} h={92} cls="node-mcp" kicker="read back" title="mcp" sub="shared context, on demand" onClick={() => onPick("mcp")} />
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
