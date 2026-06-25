import { Reveal } from "./reveal";

type Tool = { name: string; icon: string; live?: boolean };

// Logos from the creed agent set, plus Koda's and pi's own favicons.
const TOOLS: Tool[] = [
  { name: "Claude Code", icon: "claudecode.svg", live: true },
  // Concrete, tested adapters ship in the CLI (cli/adapters). Codex and OpenCode
  // are live; pi, Hermes, and Koda ride the generic adapter or MCP for now.
  { name: "Codex", icon: "codex.svg", live: true },
  { name: "OpenCode", icon: "opencode.svg", live: true },
  { name: "pi", icon: "pi.svg" },
  { name: "Hermes", icon: "hermes.svg" },
  { name: "Koda", icon: "koda.png" },
];

export function ToolsSection() {
  return (
    <section id="agents" className="lsection alt">
      <div className="wrap">
        <Reveal as="h2" className="lsection-title" text="Bring your own agent." />
        <p className="sub lsection-lead">
          Reins captures from Claude Code, Codex, and OpenCode today. Any other agent that can run a
          shell command works through the generic adapter, with more first-class adapters on the way.
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
