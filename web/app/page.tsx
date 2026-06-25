import Link from "next/link";
import { LandingHero } from "@/components/landing-hero";
import { LandingHeroBounce } from "@/components/landing-hero-bounce";
import { FooterPeek } from "@/components/footer-peek";
import { ToolsSection } from "@/components/tools";
import { HowItWorks } from "@/components/how-it-works";
import { StickyHeader } from "@/components/sticky-header";
import { Reveal } from "@/components/reveal";

export const metadata = {
  title: "Reins: shared context for teams building with AI agents",
  description:
    "Each teammate's coding agent already reports what it's doing. Reins gathers that into one shared, up-to-date view of the work: status to glance at, and tasks a teammate can pick up.",
};

const GITHUB = "https://github.com/aruntemme/reins";

export default function Landing() {
  return (
    <>
      {/* Floating header that slides in after you scroll past the hero nav. */}
      <StickyHeader />

      {/* Bouncing-mascot hero. To revert: swap back to <LandingHero />. */}
      <LandingHeroBounce />

      <main>
        {/* ── Why ────────────────────────────────────────── */}
        <section id="why" className="lsection">
          <div className="wrap">
            <Reveal as="h2" className="lsection-title" text={"A context.md goes stale\nthe moment you save it."} />
            <p className="sub lsection-lead">
              Docs drift from what&rsquo;s actually happening almost right away. But now that everyone
              works through an agent, there&rsquo;s already a live record of what each person is doing.
              Reins just reads it.
            </p>
            <div className="whycards">
              <div className="card pad whycard">
                <div className="label"><span className="sq" /> nothing to write</div>
                <p>No one logs updates. The hook reads what your agent already produces: every prompt and every turn.</p>
              </div>
              <div className="card pad whycard">
                <div className="label"><span className="sq blue" /> for the whole team</div>
                <p>A lead sees status and risks at a glance. A teammate sees what&rsquo;s blocked and what&rsquo;s free to pick up.</p>
              </div>
              <div className="card pad whycard">
                <div className="label"><span className="sq active" /> one shared view</div>
                <p>Any agent can pull the current context over MCP, so everyone reads from the same place.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ── How it works (interactive) ─────────────────── */}
        <HowItWorks />

        {/* ── Works with your agent ──────────────────────── */}
        <ToolsSection />

        {/* ── Get started ────────────────────────────────── */}
        <section id="start" className="lsection">
          <div className="wrap">
            <Reveal as="h2" className="lsection-title" text="Three steps. Everything in one place." />
            <div className="startgrid">
              <div className="startstep">
                <div className="mono num">1 · install the hook</div>
                <pre className="code">npx reins-hook install \
  --url https://your-reins --me you</pre>
                <p className="muted">Then run <code>/hooks</code> in Claude Code to approve it.</p>
              </div>
              <div className="startstep">
                <div className="mono num">2 · just work</div>
                <p>Keep working as usual. Each prompt and turn flows in and gets summarized. There&rsquo;s nothing to log.</p>
              </div>
              <div className="startstep">
                <div className="mono num">3 · open the board</div>
                <p>Paste your access token once, and watch the team&rsquo;s status, pending work, and handoffs update live.</p>
                <Link href="/dashboard" className="btn solid" style={{ marginTop: 6 }}>Open the dashboard</Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="lfooter">
        <FooterPeek />
        <div className="wrap lfooter-in">
          <div className="brand"><span className="mono" style={{ fontSize: 15 }}>reins</span></div>
          <div className="lfooter-links mono">
            <a href="#why">why</a>
            <a href="#how">how it works</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">github</a>
            <a href="https://www.npmjs.com/package/reins-hook" target="_blank" rel="noreferrer">npm</a>
            <Link href="/dashboard">dashboard</Link>
          </div>
          <div className="mono muted">hook / distill / live shared context / MCP</div>
        </div>
      </footer>
    </>
  );
}
