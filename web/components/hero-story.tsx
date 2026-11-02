import type { CSSProperties, ReactNode } from "react";

/**
 * The hero's 14s loop: asha's agent edits src/auth/session.ts, ravi's agent is
 * warned before touching the same file, reroutes, and picks it up after asha
 * commits. Pure CSS (landing.css), so it costs no JavaScript; every animation
 * stops under prefers-reduced-motion and the finished transcript stays visible.
 * Desktop shows lanes + two terminals; phones get the vertical card.
 */

const at = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

function Ln({ d, className, children }: { d: number; className?: string; children: ReactNode }) {
  return (
    <span className={`lp-l${className ? ` ${className}` : ""}`} style={at(d)}>
      {children}
    </span>
  );
}

const B = () => <span className="lp-b" aria-hidden="true">●</span>;

function Chip({ initial, name, pulse, children }: { initial: string; name?: string; pulse?: boolean; children: ReactNode }) {
  return (
    <span className="lp-pchip">
      <span className={`lp-pchip-av${pulse ? " pulse" : ""}`}>{initial}</span>
      {name && <span className="lp-pchip-name">{name}</span>}
      <span className="lp-swap">{children}</span>
    </span>
  );
}

function Terminal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="lp-term">
      <div className="lp-term-bar">
        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
        <span className="lp-term-title">{title}</span>
      </div>
      <div className="lp-term-body">{children}</div>
    </div>
  );
}

function Desktop() {
  return (
    <div className="lp-story-desk">
      <div className="lp-lanes" aria-hidden="true">
        <div className="lp-branches">
          <span>feat/oauth</span>
          <span>fix/refresh</span>
          <span>feat/cart</span>
        </div>
        <div className="lp-lanes-in">
          <i className="lp-rail" /><i className="lp-rail" /><i className="lp-rail" />
          <i className="lp-glow" />
          <i className="lp-free" />
          <div className="lp-agent lp-asha">
            <i className="lp-tail" />
            <Chip initial="A" name="asha" pulse>
              <span className="lp-a1">Claude Code · session.ts</span>
              <span className="lp-a2">committed ✓</span>
            </Chip>
          </div>
          <div className="lp-agent lp-ravi">
            <Chip initial="R" name="ravi">
              <span className="lp-s1">Codex · wants session.ts</span>
              <span className="lp-s2">Codex · cart/expiry.ts</span>
              <span className="lp-s3">Codex · takes session.ts</span>
            </Chip>
            <i className="lp-tail" />
          </div>
          <div className="lp-agent lp-mei">
            <i className="lp-tail" />
            <Chip initial="M" name="mei">
              <span>OpenCode · cart/summary.tsx</span>
            </Chip>
          </div>
        </div>
        <i className="lp-marker" />
        <span className="lp-file">src/auth/session.ts</span>
        <span className="lp-pill">heads-up · same file, before the edit</span>
      </div>

      <div className="lp-wrap lp-terms-wrap">
        <div className="lp-terms">
          <Terminal title="asha — claude code — feat/oauth">
            <Ln d={0} className="cmd">› add PKCE to the oauth callback</Ln>
            <Ln d={0.6}><B /> Read src/auth/session.ts</Ln>
            <Ln d={1.2}><B /> Edit src/auth/session.ts <span className="lp-add">+42</span> <span className="lp-del">−8</span></Ln>
            <Ln d={1.8} className="note">reins ▸ shared: asha on session.ts</Ln>
            <Ln d={5.4}><B /> Edit src/auth/pkce.ts <span className="lp-add">+61</span></Ln>
            <Ln d={6.2}><B /> Run npm test</Ln>
            <Ln d={7.4} className="ind lp-add">18 passed · 0 failed</Ln>
            <Ln d={8.4}><B /> Commit “oauth: PKCE on callback”</Ln>
            <Ln d={9.2} className="note">reins ▸ session.ts free for ravi</Ln>
          </Terminal>

          <div className="lp-col">
            <i className="lp-wire" aria-hidden="true" />
            <div className="lp-col-in">
              <div className="lp-col-h">
                <strong><i className="lp-dot" aria-hidden="true" />reins</strong>
                <span>live team state</span>
              </div>
              <Ln d={1.9} className="lp-ev"><b>asha</b> is editing<code>src/auth/session.ts</code></Ln>
              <Ln d={2.9} className="lp-ev overlap"><b>Overlap caught</b><br />ravi’s agent wanted the same file. Warned before the edit.</Ln>
              <Ln d={4.4} className="lp-ev"><b>ravi</b> rerouted to<code>src/cart/expiry.ts</code></Ln>
              <Ln d={9.3} className="lp-ev"><b>Handoff</b> · session.ts is free. ravi picks it up.</Ln>
            </div>
          </div>

          <Terminal title="ravi — codex — fix/refresh">
            <Ln d={0.3} className="cmd">› expire refresh tokens after 30 days</Ln>
            <Ln d={1.5}><B /> Plan: edit src/auth/session.ts</Ln>
            <Ln d={2.8} className="lp-warn">
              <b>reins ▸ heads-up before edit</b><br />asha is editing session.ts<br />(2m ago, feat/oauth). Coordinate first.
            </Ln>
            <Ln d={4.2}><B /> I’ll do cart/expiry.ts first and</Ln>
            <Ln d={4.2} className="ind">leave session.ts to asha.</Ln>
            <Ln d={5.2}><B /> Edit src/cart/expiry.ts <span className="lp-add">+19</span> <span className="lp-del">−3</span></Ln>
            <Ln d={9.6} className="note">reins ▸ session.ts is free now</Ln>
            <Ln d={10.6}><B /> Edit src/auth/session.ts <span className="lp-add">+12</span> <span className="lp-del">−4</span></Ln>
          </Terminal>
        </div>
      </div>
    </div>
  );
}

function Mobile() {
  return (
    <div className="lp-story-mob">
      <div className="lp-m-lanes" aria-hidden="true">
        <i className="lp-rail" /><i className="lp-rail" /><i className="lp-rail" />
        <i className="lp-marker" />
        <span className="lp-file">session.ts</span>
        <i className="lp-glow" />
        <i className="lp-free" />
        <div className="lp-agent lp-asha">
          <Chip initial="A" pulse>
            <span className="lp-a1">asha · editing</span>
            <span className="lp-a2">committed ✓</span>
          </Chip>
        </div>
        <div className="lp-agent lp-ravi">
          <Chip initial="R">
            <span className="lp-s1">wants it</span>
            <span className="lp-s2">expiry.ts</span>
            <span className="lp-s3">takes it</span>
          </Chip>
        </div>
        <span className="lp-pill">heads-up · same file, before the edit</span>
      </div>
      <div className="lp-m-state">
        <strong><i className="lp-dot" aria-hidden="true" />reins · live team state</strong>
        <Ln d={1.9}><b>asha</b> is editing <code>src/auth/session.ts</code></Ln>
        <Ln d={2.9} className="overlap"><b>Overlap caught.</b> ravi’s agent was warned before the edit.</Ln>
        <Ln d={4.4}><b>ravi</b> rerouted to <code>cart/expiry.ts</code></Ln>
        <Ln d={9.3}><b>Handoff</b> · session.ts is free. ravi picks it up.</Ln>
      </div>
    </div>
  );
}

export function HeroStory() {
  return (
    <figure className="lp-story" aria-label="Asha's and Ravi's agents coordinating on one file through Reins">
      <Desktop />
      <Mobile />
    </figure>
  );
}
