import Link from "next/link";
import { Mark } from "./ui";

const GITHUB = "https://github.com/aruntemme/reins";
const LIGS = ["ffi", "ffl", "fi", "fl", "ff"];

/** Split into per-character chunks, keeping common Latin ligatures glued. */
function splitGlyphs(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const lig = LIGS.find((l) => chars.slice(i, i + l.length).join("") === l);
    if (lig) { out.push(lig); i += lig.length; }
    else { out.push(chars[i]!); i += 1; }
  }
  return out;
}

// Pure-CSS per-glyph blur-in (keyframes + animation-delay): no JS gating, so
// it's immune to hydration/runtime quirks and runs the moment the page paints.
const HEADLINE = "The context your team\nactually shares.";

export function LandingHero() {
  const lines = HEADLINE.split("\n");
  let n = 0;
  return (
    <section className="lhero">
      <div className="lhero-card">
        <div className="lhero-art" style={{ backgroundImage: "url('/hero.jpg')" }} />
        <div className="lhero-wash" />

        <div className="lhero-fg">
          <header className="lhero-nav">
            <Link href="/" className="brand"><Mark /> reins</Link>
            <nav className="navlinks">
              <a href="#why">Why</a>
              <a href="#pipeline">Pipeline</a>
              <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
              <Link href="/dashboard" className="btn solid">Open dashboard</Link>
            </nav>
          </header>

          <div className="lhero-center">
           <div className="lhero-copy">
            <h1 className="lhero-title">
              {lines.map((line, li) => (
                <span key={li} className="lhero-line">
                  {splitGlyphs(line).map((g, gi) => {
                    const i = n++;
                    return (
                      <span key={gi} className="lhero-glyph" style={{ animationDelay: `${0.12 + i * 0.04}s` }}>
                        {g === " " ? " " : g}
                      </span>
                    );
                  })}
                </span>
              ))}
            </h1>

            <div className="lhero-rule" style={{ animationDelay: "1.35s" }} />

            <p className="sub lhero-sub lhero-fade" style={{ animationDelay: "1.6s" }}>
              Every teammate&rsquo;s AI agent already narrates what it&rsquo;s doing. Reins distills it
              live into one shared brain.
            </p>

            <div className="lhero-cta lhero-fade" style={{ animationDelay: "1.82s" }}>
              <Link href="/dashboard" className="btn solid lg">Open the dashboard</Link>
              <code className="installcmd">npx reins-hook install</code>
            </div>
           </div>
          </div>
        </div>
      </div>
    </section>
  );
}
