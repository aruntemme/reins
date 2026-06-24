import { Reveal } from "./reveal";

type Tool = { name: string; icon: string; live?: boolean };

// Logos from the creed agent set, plus Koda's and pi's own favicons.
const TOOLS: Tool[] = [
  { name: "Claude Code", icon: "claudecode.svg", live: true },
  { name: "Codex", icon: "codex.svg" },
  { name: "pi", icon: "pi.svg" },
  { name: "Hermes", icon: "hermes.svg" },
  { name: "Koda", icon: "koda.png" },
  { name: "OpenCode", icon: "opencode.svg" },
];

export function ToolsSection() {
  return (
    <section id="agents" className="lsection alt">
      <div className="wrap">
        <Reveal as="h2" className="lsection-title" text="Bring your own agent." />
        <p className="sub lsection-lead">
          Today Reins captures from Claude Code. Support for more agents is on the way.
        </p>

        <div className="label tools-label"><span className="sq" /> agents</div>
        <div className="tools-grid">
          {TOOLS.map((t) => (
            <div key={t.name} className={`tool ${t.live ? "live" : "soon"}`} tabIndex={0}>
              <div className="tool-tile">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/assets/agents/${t.icon}`} alt={t.name} width={28} height={28} />
              </div>
              <div className="tool-name">{t.name}</div>
              {!t.live && <span className="tool-badge">coming soon</span>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
