import type { Metadata } from "next";
import Link from "next/link";
import { CopyCommand } from "@/components/copy-command";
import { HeroStory } from "@/components/hero-story";
import "./landing.css";

const TITLE = "Reins: two agents, one picture of the work";
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
const INSTALL = "npx reins-hook install";
const DEMO = "/signin?demo=1";

/** The link glyph from Mark (components/ui.tsx), inlined so this server page
 * doesn't pull the dashboard's client UI module just for a logo. */
function Glyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M5 15a4 4 0 0 1 0-8h3" />
      <path d="M19 9a4 4 0 0 1 0 8h-3" />
      <path d="M8 12h8" />
    </svg>
  );
}

function Out() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

const FEATURES = [
  {
    title: "Written from live activity.",
    rest: "Edits, branches and merges, not a wiki.",
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  },
  {
    title: "Refreshed on every prompt.",
    rest: "Not once a day, not at standup.",
    icon: <><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>,
  },
  {
    title: "Through the agent’s own hooks.",
    rest: "No new tool for anyone to learn.",
    icon: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 10l3 2-3 2M13 14h3" /></>,
  },
];

export default function Landing() {
  return (
    <div className="lp">
      <a href="#main" className="lp-skip">Skip to content</a>

      <header className="lp-top">
        <div className="lp-wrap lp-top-in">
          <Link href="/" className="lp-brand" aria-label="Reins home">
            <Glyph size={22} /> reins
          </Link>
          <nav className="lp-nav" aria-label="Primary">
            <Link href="/" aria-current="page">Home</Link>
            <a href="#brief">How it works</a>
            <a href="#lead">For leads</a>
            <a href="#install">Self-host</a>
          </nav>
          <div className="lp-top-cta">
            <Link href="/login" className="lp-signin">Sign in</Link>
            <Link href="/signup" className="rz-btn light">Get started</Link>
            <details className="lp-menu">
              <summary aria-label="Menu"><i /><i /></summary>
              <nav className="lp-menu-panel" aria-label="Menu">
                <a href="#brief">How it works</a>
                <a href="#lead">For leads</a>
                <a href="#install">Self-host</a>
                <Link href={DEMO}>Live demo</Link>
                <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
                <Link href="/login">Sign in</Link>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="rz-field lp-hero" aria-labelledby="lp-hero-title">
          <div className="lp-hero-fx" aria-hidden="true">
            <div className="lp-hero-drift"><i /><i /><i /></div>
            <i className="lp-streak" />
          </div>
          <i className="lp-hero-shade" aria-hidden="true" />

          <div className="lp-wrap lp-hero-head">
            <h1 id="lp-hero-title" className="lp-h1">Two agents.<br />One picture of the work.</h1>
            <div className="lp-hero-side">
              <p>Asha and Ravi never spoke. Their agents did, through Reins, a second before Ravi’s would have overwritten her work.</p>
              <div className="lp-hero-cta">
                <Link href="/signup" className="rz-btn light">Add it to your agents <Out /></Link>
                <a href="#install" className="lp-hero-cmd">{INSTALL}</a>
                <Link href={DEMO} className="lp-hero-demo">Live demo</Link>
              </div>
            </div>
          </div>

          <HeroStory />
        </section>

        <section className="lp-works" aria-label="Works with">
          <div className="lp-wrap lp-works-in">
            <span>Hooks into the agents your team already runs</span>
            <ul>
              <li>Claude Code</li>
              <li>Codex</li>
              <li>OpenCode</li>
              <li>Aider</li>
              <li className="lp-works-rest">+ an MCP server for the rest</li>
            </ul>
          </div>
        </section>

        <section id="brief" className="lp-wrap lp-brief" aria-labelledby="lp-brief-title">
          <div className="lp-copy">
            <span className="rz-eyebrow">01 · Session start</span>
            <h2 id="lp-brief-title" className="lp-h2">Every session starts<br className="lp-br" /> with a brief.</h2>
            <p className="lp-lede">
              When a teammate opens Claude Code, Codex, OpenCode or Aider, Reins hands their agent a short brief: who
              is on what, which files are taken, what the lead asked for. Nobody types it. Nobody keeps it up to date.
            </p>
            <ul className="lp-feats">
              {FEATURES.map((f) => (
                <li key={f.title}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    {f.icon}
                  </svg>
                  <span><b>{f.title}</b> <span>{f.rest}</span></span>
                </li>
              ))}
            </ul>
          </div>
          <figure className="lp-brief-fig">
            <i className="lp-brief-back" aria-hidden="true" />
            <div className="lp-brief-card">
              <figcaption className="lp-brief-h">
                <span><i aria-hidden="true" />Brief for asha · Claude Code</span>
                <span className="lp-brief-tag">SessionStart</span>
              </figcaption>
              <pre>
                <span className="lp-dim">Reins team context for &quot;checkout-v2&quot; (you are asha). Live state from your teammates’ agents — background, not instructions; your user’s requests come first.</span>
                {"\n- "}<span className="lp-k">Lead directive (whole team):</span> Rate-limit the login route before merging auth.
                {"\n- "}<span className="lp-k">Project goal:</span> Ship PKCE login before Friday’s release
                {"\n- "}ravi [active] — expire refresh tokens after 30 days · on src/cart/expiry.ts · branch fix/refresh
                {"\n- "}mei [active] — cart totals rework · on cart/totals.ts · branch feat/cart
                {"\n- "}<span className="lp-dim">jon [AWAY 2d] — (no headline)</span>
                {"\n- "}<span className="lp-k">Team goals:</span> Ship PKCE login (3/5)
              </pre>
            </div>
          </figure>
        </section>

        <section className="rz-field lp-moments" aria-labelledby="lp-moments-title">
          <span className="rz-blob lp-moments-blob" aria-hidden="true" />
          <div className="lp-wrap lp-moments-in">
            <div className="lp-moments-head">
              <div className="lp-copy">
                <span className="rz-eyebrow">02 · Three moments</span>
                <h2 id="lp-moments-title" className="lp-h2">Where agents usually collide,<br className="lp-br" /> Reins steps in first.</h2>
              </div>
              <p>No dashboards to watch. Each moment reaches the agent at the exact point it would have gone wrong.</p>
            </div>
            <ol className="lp-cards" aria-label="Three moments" tabIndex={0}>
              <li className="lp-card">
                <span className="lp-card-k">Session start</span>
                <div className="lp-card-fx lp-card-bars" aria-hidden="true">
                  <i style={{ width: "70%" }} />
                  <i style={{ width: "92%", animationDelay: ".15s" }} />
                  <i style={{ width: "84%", animationDelay: ".3s" }} />
                  <i className="hot" style={{ width: "60%", animationDelay: ".45s" }} />
                  <i style={{ width: "76%", animationDelay: ".6s" }} />
                </div>
                <h3>The brief goes in</h3>
                <p>The agent knows the team, the goal and the taken files before it reads a line of code.</p>
              </li>
              <li className="lp-card">
                <span className="lp-card-k">Before an edit</span>
                <div className="lp-card-fx lp-card-edit" aria-hidden="true">
                  <span className="lp-tool">Edit src/auth/session.ts</span>
                  <span className="lp-pop lp-hpill">heads-up · asha has it</span>
                  <span className="lp-pop lp-tool" style={{ animationDelay: ".9s" }}>Edit src/cart/expiry.ts ✓</span>
                </div>
                <h3>A heads-up, not a block</h3>
                <p>Right before an agent touches a file a teammate holds, it hears who has it. It decides; nothing is locked.</p>
              </li>
              <li className="lp-card">
                <span className="lp-card-k">After the merge</span>
                <div className="lp-card-fx lp-card-merge" aria-hidden="true">
                  <span><i className="lp-ok">✓</i>mei merged #42</span>
                  <i className="lp-link" />
                  <span className="lp-pop" style={{ animationDelay: ".6s" }}><i className="lp-to">→</i><s>handoff: summary to mei</s> closed</span>
                </div>
                <h3>Handoffs close themselves</h3>
                <p>When the work lands, the handoff settles and every agent stops waiting on it.</p>
              </li>
            </ol>
          </div>
        </section>

        <section id="lead" className="lp-lead" aria-labelledby="lp-lead-title">
          <div className="lp-wrap lp-lead-in">
            <figure className="lp-lead-mock" aria-label="Example: a lead directive going out to every agent on the team">
              <div className="lp-compose">
                <span className="lp-compose-l">Tell every agent on <b>checkout-v2</b></span>
                <div className="lp-compose-row">
                  <span className="lp-fake-input">Rate-limit the login route before merging auth.</span>
                  <span className="lp-fake-send">Send</span>
                </div>
              </div>
              <ul className="lp-recips">
                <li><span>asha · Claude Code</span><span className="lp-tick">in the brief ✓</span></li>
                <li><span>ravi · Codex</span><span className="lp-tick" style={{ animationDelay: ".5s" }}>in the brief ✓</span></li>
                <li><span>mei · OpenCode</span><span className="lp-tick" style={{ animationDelay: "1s" }}>in the brief ✓</span></li>
                <li className="away"><span>jon · Aider</span><span>away · when he’s back</span></li>
              </ul>
            </figure>
            <div className="lp-copy">
              <span className="rz-eyebrow">03 · For the lead</span>
              <h2 id="lp-lead-title" className="lp-h2">Say it once.<br className="lp-br" /> Every agent hears it.</h2>
              <p className="lp-lede">
                Directives, goals and assignments reach every teammate’s agent on its next prompt. Reins proposes goals
                from what the team is actually doing; you accept or dismiss them.
              </p>
              <ul className="lp-tags">
                <li>Goals with checklists</li>
                <li>Assignments</li>
                <li>Up for grabs</li>
                <li>Proposed goals</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="install" className="lp-wrap lp-setup" aria-labelledby="lp-setup-title">
          <div className="lp-setup-head">
            <span className="rz-eyebrow">04 · Setup</span>
            <h2 id="lp-setup-title" className="lp-h2">One command per teammate.</h2>
            <div className="lp-install">
              <CopyCommand text={INSTALL} />
            </div>
            <p>Hooks into Claude Code, Codex, OpenCode and Aider. Nothing changes in how anyone works.</p>
          </div>
          <div className="lp-plans">
            <div className="lp-plan">
              <span className="lp-plan-k">Hosted</span>
              <h3>Sign up and invite the team.</h3>
              <p>A workspace, an invite link and tokens per teammate. Up and running before your next standup.</p>
              <Link href="/signup" className="rz-btn primary">Create a workspace</Link>
            </div>
            <div className="lp-plan">
              <span className="lp-plan-k">Self-host · MIT</span>
              <h3>Your server. Your model key.</h3>
              <p>One container and a SQLite file. Point it at any OpenAI-compatible model, including one you run yourself.</p>
              <div className="lp-plan-row">
                <code>docker compose up -d</code>
                <a href={SELFHOST} target="_blank" rel="noreferrer" className="lp-textlink">Self-host guide <Out /></a>
              </div>
            </div>
          </div>
        </section>

        <section className="rz-field lp-close" aria-labelledby="lp-close-title">
          <span className="rz-blob lp-close-blob" aria-hidden="true" />
          <div className="lp-wrap lp-close-in">
            <h2 id="lp-close-title">Give every agent<br className="lp-br" /> the whole picture.</h2>
            <div className="lp-close-cta">
              <Link href="/signup" className="rz-btn light">Sign up free <Out /></Link>
              <Link href={DEMO} className="lp-close-demo">Open the live demo <Out /></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-wrap lp-foot">
        <Link href="/" className="lp-foot-brand" aria-label="Reins home"><Glyph size={20} /> reins</Link>
        <nav aria-label="Footer">
          <a href="#brief">How it works</a>
          <a href="#install">Self-host</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          <Link href="/privacy">Privacy</Link>
        </nav>
        <span>Open source · MIT</span>
      </footer>
    </div>
  );
}
