import Link from "next/link";
import { LandingHero } from "@/components/landing-hero";

export const metadata = {
  title: "Reins — live shared context for AI-agent teams",
  description:
    "Every teammate's AI agent reports what it's doing. Reins distills it live into one shared brain — status a lead can glance at, work a peer can grab, without a single standup.",
};

const GITHUB = "https://github.com/aruntemme/reins";

export default function Landing() {
  return (
    <>
      <LandingHero />

      <main>
        {/* ── Why ────────────────────────────────────────── */}
        <section id="why" className="lsection">
          <div className="wrap">
            <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> why</div>
            <h2 className="display lsection-title">
              Your <code>context.md</code> is stale the moment you save it.
            </h2>
            <p className="sub lsection-lead">
              The gap between what the docs say and what&rsquo;s actually happening is the most
              expensive problem on any team. Now that everyone drives an agent, there&rsquo;s finally a
              machine-readable stream of intent to tap — for free.
            </p>
            <div className="whycards">
              <div className="card pad whycard">
                <div className="label"><span className="sq" /> captured, not written</div>
                <p>No one logs anything. The hook siphons what your agent already produces — every prompt and turn.</p>
              </div>
              <div className="card pad whycard">
                <div className="label"><span className="sq blue" /> for the whole team</div>
                <p>A lead sees status and risks at a glance. A peer sees what&rsquo;s blocked and grabs what&rsquo;s up for grabs.</p>
              </div>
              <div className="card pad whycard">
                <div className="label"><span className="sq active" /> a shared brain</div>
                <p>Any agent can pull the live context over MCP — so everyone&rsquo;s agent reads from the same source of truth.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Pipeline ───────────────────────────────────── */}
        <section id="pipeline" className="lsection alt">
          <div className="wrap">
            <div className="label" style={{ marginBottom: 18 }}><span className="sq active" /> the pipeline</div>
            <h2 className="display lsection-title">Noise in. Signal out.</h2>
            <p className="sub lsection-lead">
              Raw agent activity is a firehose. Each event runs through a multi-agent, provider-neutral
              LLM pipeline that turns it into living context — not a dump of logs.
            </p>
            <div className="steps">
              {[
                ["01", "triage", "Gate the noise. Most low-content events stop here."],
                ["02", "extract", "Pull structured facts: intent, actions, files, decisions, blockers."],
                ["03", "reconcile", "Merge into each person's living context — headline, status, pending, handoffs."],
                ["04", "rollup", "Synthesize the whole team: status, goal-alignment, collisions, risks."],
              ].map(([n, t, d]) => (
                <div className="step" key={n}>
                  <div className="stepnum mono">{n}</div>
                  <div className="steplabel">{t}</div>
                  <p>{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Get started ────────────────────────────────── */}
        <section id="start" className="lsection">
          <div className="wrap">
            <div className="label" style={{ marginBottom: 18 }}><span className="sq" /> get started</div>
            <h2 className="display lsection-title">Three steps. No standup.</h2>
            <div className="startgrid">
              <div className="startstep">
                <div className="mono num">1 — install the hook</div>
                <pre className="code">npx reins-hook install \
  --url https://your-reins --me you</pre>
                <p className="muted">Then run <code>/hooks</code> in Claude Code to approve it.</p>
              </div>
              <div className="startstep">
                <div className="mono num">2 — just work</div>
                <p>Every prompt and agent turn flows to the board and gets distilled into live context. Nothing to log.</p>
              </div>
              <div className="startstep">
                <div className="mono num">3 — open the board</div>
                <p>Paste your access token once. Watch the team&rsquo;s status, pending work, and handoffs update live.</p>
                <Link href="/dashboard" className="btn solid" style={{ marginTop: 6 }}>Open the dashboard →</Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="lfooter">
        <div className="wrap lfooter-in">
          <div className="brand"><span className="mono" style={{ fontSize: 15 }}>reins</span></div>
          <div className="lfooter-links mono">
            <a href="#why">why</a>
            <a href="#pipeline">pipeline</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">github</a>
            <a href="https://www.npmjs.com/package/reins-hook" target="_blank" rel="noreferrer">npm</a>
            <Link href="/dashboard">dashboard</Link>
          </div>
          <div className="mono muted">hook → distill → live shared context → MCP</div>
        </div>
      </footer>
    </>
  );
}
