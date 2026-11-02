import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";
import { CopyCommand } from "@/components/copy-command";
import { LandingDemo } from "@/components/landing-demo";
import "./landing.css";

// Landing-only faces, loaded here (not in the root layout) so the dashboard
// never downloads them.
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--rl-font-display",
  display: "swap",
});
const sans = Geist({ subsets: ["latin"], variable: "--rl-font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--rl-font-mono", display: "swap" });

const TITLE = "Reins: your agents know what your teammates' agents are doing";
const DESCRIPTION =
  "Reins reads what every teammate's coding agent is doing, in any tool, turns it into live team intent, and feeds it back into every agent, so overlaps surface before the edit, not at the merge.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Reins",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const GITHUB = "https://github.com/aruntemme/reins";
const SELFHOST = `${GITHUB}/blob/main/SELFHOST.md`;
const NPM = "https://www.npmjs.com/package/reins-hook";
const INSTALL = "npx reins-hook install";

const AGENTS = [
  { name: "Claude Code", icon: "claudecode.svg" },
  { name: "Codex", icon: "codex.svg" },
  { name: "OpenCode", icon: "opencode.svg" },
  { name: "Aider", icon: "aider.png" },
];

/** The Reins mascot mark (same glyph as app/icon.svg), inlined so the landing
 * page doesn't pull the dashboard's client UI bundle just for a logo. */
function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="rl-mark">
      <path d="M16 5C23 5 27 10 27 17C27 24 22 27 16 27C10 27 5 24 5 17C5 10 9 5 16 5Z" fill="#F0CD58" />
      <circle cx="13" cy="16" r="2" fill="#1b1a17" />
      <circle cx="21" cy="16" r="2" fill="#1b1a17" />
      <path d="M13 21C15 22.5 17 22.5 19 21" stroke="#1b1a17" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Arrow() {
  return <span aria-hidden="true" className="rl-arrow">→</span>;
}

function GetStarted({ id }: { id?: string }) {
  return (
    <div className="rl-cta" id={id}>
      <Link href="/signup" className="rl-btn rl-btn-solid">
        Sign up <Arrow />
      </Link>
      <CopyCommand text={INSTALL} />
      <Link href="/signin?demo=1" className="rl-textlink">
        Try the live demo <Arrow />
      </Link>
    </div>
  );
}

export default function Landing() {
  return (
    <div className={`rl ${display.variable} ${sans.variable} ${mono.variable}`}>
      <a href="#main" className="rl-skip">Skip to content</a>

      <header className="rl-header">
        <div className="rl-wrap rl-header-in">
          <Link href="/" className="rl-brand" aria-label="Reins home">
            <Mark size={26} /> <span>reins</span>
          </Link>
          <nav className="rl-nav" aria-label="Primary">
            <a href="#how">How it works</a>
            <a href="#why">Why Reins</a>
            <a href="#self-host">Self-host</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          </nav>
          <div className="rl-header-cta">
            <Link href="/login" className="rl-textlink rl-login">Log in</Link>
            <Link href="/signup" className="rl-btn rl-btn-solid rl-btn-sm">Sign up</Link>
          </div>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="rl-hero" aria-labelledby="rl-hero-title">
          <div className="rl-wrap">
            <p className="rl-eyebrow">
              <span className="rl-live" aria-hidden="true" /> Live intent for teams of humans and agents
            </p>
            <h1 id="rl-hero-title" className="rl-h1">
              Your agent knows what your <em>teammate&rsquo;s</em> agent is doing.
            </h1>
            <p className="rl-lede">
              Reins reads what every teammate&rsquo;s coding agent is doing, in any tool, turns it into live
              team intent, and feeds it back into every agent. Overlaps surface before the edit, not at the merge.
            </p>
            <GetStarted />
          </div>
          <div className="rl-wrap rl-hero-demo">
            <LandingDemo />
          </div>
        </section>

        {/* Works with */}
        <section className="rl-agents" aria-labelledby="rl-agents-title">
          <div className="rl-wrap rl-agents-in">
            <h2 id="rl-agents-title" className="rl-agents-title">
              One context across every agent your team runs
            </h2>
            <ul className="rl-agents-list">
              {AGENTS.map((a) => (
                <li key={a.name}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/assets/agents/${a.icon}`} alt="" width={22} height={22} />
                  {a.name}
                </li>
              ))}
              <li className="rl-agents-any">and anything that runs a shell hook</li>
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="rl-section" aria-labelledby="rl-how-title">
          <div className="rl-wrap">
            <div className="rl-section-head">
              <p className="rl-kicker">How it works</p>
              <h2 id="rl-how-title" className="rl-h2">One hook in. Team intent out.</h2>
              <p className="rl-sub">
                Nobody writes a status update. Reins listens to the work your agents already do and
                hands the result back to all of them.
              </p>
            </div>

            <ol className="rl-steps">
              <li className="rl-step">
                <span className="rl-step-n">01</span>
                <h3>Install one hook</h3>
                <p>
                  Each teammate runs one command. Claude Code, Codex, OpenCode and Aider have adapters,
                  and any other agent that can run a shell command uses the generic one.
                </p>
                <pre className="rl-frag rl-frag-code"><span className="rl-dim">$</span> {INSTALL} --me maya</pre>
              </li>
              <li className="rl-step">
                <span className="rl-step-n">02</span>
                <h3>Reins distills intent</h3>
                <p>
                  Prompts, turns, file edits and branch switches run through a short pipeline on the model
                  you choose. Out comes a live status per person and a team rollup: summary, goal
                  alignment, file collisions and risks.
                </p>
                <div className="rl-frag rl-pipe" aria-label="Pipeline: triage, extract, reconcile, rollup">
                  <span>triage</span><Arrow /><span>extract</span><Arrow /><span>reconcile</span><Arrow /><span>rollup</span>
                </div>
              </li>
              <li className="rl-step">
                <span className="rl-step-n">03</span>
                <h3>Every agent gets it back</h3>
                <p>
                  Agents get a short team briefing when a session starts and an update when something
                  changes. Any agent can ask for more over MCP, and your team watches the same state on a
                  live board.
                </p>
                <pre className="rl-frag rl-frag-code"><span className="rl-dim">mcp</span> reins_context --member maya</pre>
              </li>
            </ol>
          </div>
        </section>

        {/* What agents hear */}
        <section id="features" className="rl-section rl-section-alt" aria-labelledby="rl-feat-title">
          <div className="rl-wrap">
            <div className="rl-section-head">
              <p className="rl-kicker">Inside every agent</p>
              <h2 id="rl-feat-title" className="rl-h2">What your agent hears, without you asking.</h2>
            </div>

            <div className="rl-bento">
              <article className="rl-tile rl-tile-wide">
                <h3>A briefing at the start of every session</h3>
                <p>Before your agent writes a line, it knows who is working on what, where, and on which branch.</p>
                <div className="rl-frag rl-brief">
                  <div className="rl-brief-h"><span className="rl-rail-mark">reins</span> team briefing, checkout-v2</div>
                  <ul>
                    <li><b>maya</b> refactoring token refresh in <code>src/auth/session.ts</code> <span className="rl-dim">maya/token-refresh</span></li>
                    <li><b>sam</b> moving payments to the new webhook flow <span className="rl-dim">sam/webhooks</span></li>
                    <li><b>lead</b> keep the v1 checkout API stable until Friday</li>
                  </ul>
                </div>
              </article>

              <article className="rl-tile">
                <h3>A heads-up before a collision</h3>
                <p>Real file-edit tracking warns your agent before it edits a file a teammate is in. It never blocks.</p>
                <div className="rl-frag rl-warn">
                  <span aria-hidden="true">▲</span> maya is editing <code>session.ts</code> right now
                </div>
              </article>

              <article className="rl-tile">
                <h3>Handoffs that close themselves</h3>
                <p>Reins opens a handoff when one agent needs another&rsquo;s work, and closes it when the work lands.</p>
                <div className="rl-frag rl-handoff">
                  <span>dev <Arrow /> maya</span>
                  <span className="rl-chip rl-chip-ok">closed</span>
                </div>
              </article>

              <article className="rl-tile">
                <h3>Lead directives that land</h3>
                <p>A lead&rsquo;s directive or assignment reaches the targeted agents on their very next turn.</p>
                <div className="rl-frag rl-directive">
                  <span className="rl-dim">to dev, sam</span> hold the payments migration until Friday
                </div>
              </article>

              <article className="rl-tile">
                <h3>Branch awareness</h3>
                <p>Status carries the branch, so &ldquo;same file&rdquo; means same file on a branch that will meet.</p>
                <div className="rl-frag rl-branch">
                  <code>maya/token-refresh</code> <span className="rl-dim">and</span> <code>dev/remember-me</code>
                </div>
              </article>

              <article className="rl-tile">
                <h3>Working-style profiles, opt-in</h3>
                <p>Each member can share how they like to work, so agents pick up the team&rsquo;s habits.</p>
                <div className="rl-frag rl-tags">
                  <span className="rl-chip">small PRs</span>
                  <span className="rl-chip">tests first</span>
                  <span className="rl-chip">no new deps</span>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* Differentiation */}
        <section id="why" className="rl-section" aria-labelledby="rl-why-title">
          <div className="rl-wrap">
            <div className="rl-section-head">
              <p className="rl-kicker">Why Reins</p>
              <h2 id="rl-why-title" className="rl-h2">Not a memory. Not a dashboard. Live intent.</h2>
              <p className="rl-sub">
                Memory tools keep what someone chose to save. Agent dashboards show runs to a person watching
                a screen. Reins watches the work as it happens, across every tool, and puts it back where
                the work happens: inside each agent.
              </p>
            </div>

            <div className="rl-compare" role="table" aria-label="How Reins compares with team memory and agent dashboards">
              <div className="rl-compare-row rl-compare-headrow" role="row">
                <span role="columnheader" className="rl-compare-corner"><span className="rl-sr">Question</span></span>
                <span role="columnheader">Team memory</span>
                <span role="columnheader">Agent dashboards</span>
                <span role="columnheader" className="rl-compare-us">Reins</span>
              </div>
              {[
                ["Where it comes from", "Notes someone decides to save", "One vendor's agent runs", "Observed from every person and agent, any vendor"],
                ["How fresh it is", "As old as the last save", "Per run", "Every turn, live"],
                ["What it captures", "Facts and documents", "Tasks and logs", "Intent: who is doing what, why, in which files"],
                ["Who reads it", "Whoever goes looking", "A person at a screen", "Every agent, automatically, and your team"],
                ["When overlaps show up", "At merge", "Inside one vendor's agents", "Before the edit, across tools"],
              ].map(([q, mem, dash, us]) => (
                <div className="rl-compare-row" role="row" key={q}>
                  <span role="rowheader" className="rl-compare-q">{q}</span>
                  <span role="cell" data-label="Team memory">{mem}</span>
                  <span role="cell" data-label="Agent dashboards">{dash}</span>
                  <span role="cell" data-label="Reins" className="rl-compare-us">{us}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Trust */}
        <section id="self-host" className="rl-section rl-section-dark" aria-labelledby="rl-trust-title">
          <div className="rl-wrap">
            <div className="rl-section-head">
              <p className="rl-kicker">Your stack</p>
              <h2 id="rl-trust-title" className="rl-h2">Your server. Your model. Your team&rsquo;s data.</h2>
            </div>
            <div className="rl-trust">
              <div className="rl-trust-item">
                <h3>Self-host it</h3>
                <p>
                  A Node server with SQLite and a Next.js dashboard. The self-host guide walks through the
                  backend, dashboard, hook and both MCP servers.
                </p>
                <a href={SELFHOST} target="_blank" rel="noreferrer" className="rl-textlink">Self-host guide <Arrow /></a>
              </div>
              <div className="rl-trust-item">
                <h3>Bring your own model</h3>
                <p>
                  The pipeline runs on any OpenAI-compatible provider. Switch whenever you like. Keys are
                  encrypted at rest with AES-256-GCM and never sent back to the browser.
                </p>
              </div>
              <div className="rl-trust-item">
                <h3>Built for teams</h3>
                <p>
                  Multi-tenant workspaces, invite links, owner, admin and member roles, and revocable tokens
                  for every hook and agent.
                </p>
              </div>
              <div className="rl-trust-item">
                <h3>Open source, MIT</h3>
                <p>Read exactly what the hook sends and what the server does with it before you install anything. Fork it, run it, change it.</p>
                <a href={GITHUB} target="_blank" rel="noreferrer" className="rl-textlink">aruntemme/reins <Arrow /></a>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="rl-final" aria-labelledby="rl-final-title">
          <div className="rl-wrap">
            <h2 id="rl-final-title" className="rl-h2 rl-final-title">
              Give every agent the <em>rest of the team.</em>
            </h2>
            <p className="rl-sub">Create a workspace, install the hook, and keep working the way you already do.</p>
            <GetStarted />
          </div>
        </section>
      </main>

      <footer className="rl-footer">
        <div className="rl-wrap rl-footer-in">
          <div className="rl-footer-brand">
            <Link href="/" className="rl-brand" aria-label="Reins home"><Mark size={24} /> <span>reins</span></Link>
            <p>Live intent for teams of humans and agents.</p>
          </div>
          <nav className="rl-footer-cols" aria-label="Footer">
            <div>
              <h2>Product</h2>
              <a href="#how">How it works</a>
              <a href="#why">Why Reins</a>
              <Link href="/signin?demo=1">Live demo</Link>
            </div>
            <div>
              <h2>Account</h2>
              <Link href="/signup">Sign up</Link>
              <Link href="/login">Log in</Link>
              <Link href="/dashboard">Dashboard</Link>
            </div>
            <div>
              <h2>Build</h2>
              <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
              <a href={NPM} target="_blank" rel="noreferrer">npm</a>
              <a href={SELFHOST} target="_blank" rel="noreferrer">Self-host guide</a>
              <Link href="/privacy">Privacy</Link>
            </div>
          </nav>
        </div>
        <div className="rl-wrap rl-footer-base">
          <span>&copy; 2026 Reins</span>
          <span className="rl-dim">Made for teams that ship with agents.</span>
        </div>
      </footer>
    </div>
  );
}
