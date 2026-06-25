"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Mark } from "./ui";
import { CopyCommand } from "./copy-command";

const GITHUB = "https://github.com/aruntemme/reins";
const LIGS = ["ffi", "ffl", "fi", "fl", "ff"];
const HEADLINE = "The context your team\nactually shares.";

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

// Four mascots in shades of the brand gold: one bright, the primary, one deep,
// and a pale one for good measure.
const BALLS = [
  { id: "blobA", from: "#ffe89a", to: "#ffcf4d" }, // bright
  { id: "blobB", from: "#ffd96b", to: "#e9c245" }, // primary
  { id: "blobC", from: "#e6bb46", to: "#c49327" }, // deep
  { id: "blobD", from: "#fff1c4", to: "#f4d97a" }, // pale
];

type Mood = "idle" | "held" | "happy" | "squish";

/** The face changes shape with the mascot's state. */
function Face({ mood }: { mood: Mood }) {
  const ink = "#1b1a17";
  if (mood === "held")
    return (
      <>
        <circle cx="13" cy="15.4" r="2.7" fill={ink} />
        <circle cx="21" cy="15.4" r="2.7" fill={ink} />
        <circle cx="16" cy="21.6" r="1.7" fill={ink} />
      </>
    );
  if (mood === "happy")
    return (
      <>
        <path d="M11 16 Q13 13.4 15 16" stroke={ink} strokeWidth="1.5" strokeLinecap="round" fill="none" />
        <path d="M19 16 Q21 13.4 23 16" stroke={ink} strokeWidth="1.5" strokeLinecap="round" fill="none" />
        <path d="M11.6 19.6 Q16 26 20.4 19.6 Z" fill={ink} />
      </>
    );
  if (mood === "squish")
    return (
      <>
        <path d="M11 14.8 L15 16.4 L11 18" stroke={ink} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M21 14.8 L17 16.4 L21 18" stroke={ink} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <ellipse cx="16" cy="21" rx="2.6" ry="2" fill={ink} />
      </>
    );
  // idle
  return (
    <>
      <circle cx="13" cy="16" r="2" fill={ink} />
      <circle cx="21" cy="16" r="2" fill={ink} />
      <path d="M13 21 C15 22.5 17 22.5 19 21" stroke={ink} strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </>
  );
}

function Mascot({ id, from, to, mood }: { id: string; from: string; to: string; mood: Mood }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <path d="M16 5C23 5 27 10 27 17C27 24 22 27 16 27C10 27 5 24 5 17C5 10 9 5 16 5Z" fill={`url(#${id})`} />
      <Face mood={mood} />
    </svg>
  );
}

type B = { x: number; y: number; vx: number; vy: number; sx: number; sy: number };

function BouncingMascots() {
  const wrap = useRef<HTMLDivElement>(null);
  const ballEls = useRef<(HTMLDivElement | null)[]>([]);
  const shadowEls = useRef<(HTMLDivElement | null)[]>([]);
  const [moods, setMoods] = useState<Mood[]>(() => BALLS.map(() => "idle" as Mood));
  const moodsRef = useRef<Mood[]>(moods);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mq = window.matchMedia("(max-width: 720px)");
    let mobile = mq.matches;

    let W = el.clientWidth;
    let H = el.clientHeight;
    // On phones the blobs are smaller and play across the full width; on wider
    // screens they stay larger and tuck into the open right side next to the copy.
    const size = () => mobile ? Math.max(44, Math.min(68, W * 0.15)) : Math.max(78, Math.min(132, W * 0.097));
    let S = size();
    let r = S / 2;

    const G = 2300;       // gravity px/s^2
    const REST = 0.72;    // bounciness (gentle)
    const RELAUNCH = 980;

    // Mobile spreads the four across the whole width; desktop clusters them right.
    const initX = mobile ? [0.16, 0.4, 0.63, 0.85] : [0.7, 0.78, 0.74, 0.86];
    const initY = [0.3, 0.16, 0.44, 0.26];
    const initVX = [-10, 14, 4, -6];
    const state: B[] = initX.map((fx, i) => ({
      x: W * fx, y: H * initY[i]!, vx: initVX[i]!, vy: 0, sx: 1, sy: 1,
    }));
    const squish = [0, 0, 0, 0];
    const happy = [0, 0, 0, 0];

    const applySize = () => {
      S = size(); r = S / 2;
      ballEls.current.forEach((n) => { if (n) { n.style.width = `${S}px`; n.style.height = `${S}px`; } });
      shadowEls.current.forEach((n) => { if (n) n.style.width = `${S}px`; });
    };
    const onResize = () => { W = el.clientWidth; H = el.clientHeight; mobile = mq.matches; applySize(); };
    window.addEventListener("resize", onResize);
    applySize();

    const setMoodAt = (i: number, m: Mood) => {
      if (moodsRef.current[i] === m) return;
      const next = moodsRef.current.slice();
      next[i] = m;
      moodsRef.current = next;
      setMoods(next);
    };

    // ── grab + throw ──────────────────────────────────────────
    let grabbed = -1;
    let offX = 0, offY = 0;
    let lastPX = 0, lastPY = 0, lastPT = 0;
    let throwVX = 0, throwVY = 0;
    const local = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const downHandlers: ((e: PointerEvent) => void)[] = [];
    if (!reduce) {
      ballEls.current.forEach((node, i) => {
        if (!node) return;
        const onDown = (e: PointerEvent) => {
          e.preventDefault();
          grabbed = i;
          const p = local(e);
          offX = p.x - state[i].x; offY = p.y - state[i].y;
          state[i].vx = 0; state[i].vy = 0;
          lastPX = p.x; lastPY = p.y; lastPT = performance.now();
          throwVX = throwVY = 0;
          try { node.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          document.body.style.cursor = "grabbing";
          setMoodAt(i, "held");
        };
        node.addEventListener("pointerdown", onDown);
        downHandlers[i] = onDown;
      });
    }
    const onMove = (e: PointerEvent) => {
      if (grabbed < 0) return;
      const p = local(e);
      const b = state[grabbed]!;
      b.x = p.x - offX; b.y = p.y - offY;
      const now = performance.now();
      const dt = Math.max(0.001, (now - lastPT) / 1000);
      throwVX = (p.x - lastPX) / dt;
      throwVY = (p.y - lastPY) / dt;
      lastPX = p.x; lastPY = p.y; lastPT = now;
    };
    const onUp = () => {
      if (grabbed < 0) return;
      const b = state[grabbed]!;
      const max = 2800;
      b.vx = Math.max(-max, Math.min(max, throwVX));
      b.vy = Math.max(-max, Math.min(max, throwVY));
      const thrown = Math.hypot(b.vx, b.vy) > 380;
      happy[grabbed] = thrown ? 0.6 : 0;
      setMoodAt(grabbed, thrown ? "happy" : "idle");
      grabbed = -1;
      document.body.style.cursor = "";
    };
    if (!reduce) {
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    }

    // ── simulation ────────────────────────────────────────────
    let raf = 0;
    let last = performance.now();
    const render = () => {
      const ground = H * 0.84 - r;
      state.forEach((b, i) => {
        const sh = shadowEls.current[i];
        const node = ballEls.current[i];
        if (node) node.style.transform = `translate3d(${b.x - r}px, ${b.y - r}px, 0) scale(${b.sx.toFixed(3)}, ${b.sy.toFixed(3)})`;
        if (sh) {
          const air = Math.max(0, Math.min(1, (ground - b.y) / (H * 0.6)));
          sh.style.transform = `translate3d(${b.x - r}px, ${ground + r - 6}px, 0) scaleX(${(1 - air * 0.55).toFixed(3)})`;
          sh.style.opacity = `${(0.26 * (1 - air * 0.8)).toFixed(3)}`;
        }
      });
    };

    if (reduce) {
      // Static, grounded, evenly spaced — no motion.
      const ground = H * 0.84 - r;
      state.forEach((b, i) => {
        b.x = mobile ? W * (0.13 + i * 0.25) : W * (0.64 + i * 0.11);
        b.y = ground; b.vx = b.vy = 0;
      });
      render();
    } else {
      const tick = (t: number) => {
        const dt = Math.min((t - last) / 1000, 0.032);
        last = t;
        const ground = H * 0.84 - r;
        const leftWall = mobile ? r : Math.max(r, W * 0.6);

        state.forEach((b, i) => {
          if (i === grabbed) return; // pointer controls it
          b.vy += G * dt;
          b.y += b.vy * dt;
          b.x += b.vx * dt;
          if (b.x < leftWall) { b.x = leftWall; b.vx = Math.abs(b.vx) * 0.92; }
          if (b.x > W - r) { b.x = W - r; b.vx = -Math.abs(b.vx) * 0.92; }
          if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * REST; }
          if (b.y >= ground) {
            b.y = ground;
            if (b.vy > 700) squish[i] = 0.16;
            b.vy = -b.vy * REST;
            b.sx = 1.24; b.sy = 0.78;
            if (Math.abs(b.vy) < 280) b.vy = -RELAUNCH * (0.82 + i * 0.12);
          }
          const k = Math.min(1, dt * 11);
          b.sx += (1 - b.sx) * k;
          b.sy += (1 - b.sy) * k;
        });

        // ball-to-ball collisions (3 pairs)
        for (let a = 0; a < state.length; a++) {
          for (let c = a + 1; c < state.length; c++) {
            const A = state[a]!, C = state[c]!;
            let dx = C.x - A.x, dy = C.y - A.y;
            let d = Math.hypot(dx, dy) || 0.001;
            const min = r * 2;
            if (d < min) {
              const nx = dx / d, ny = dy / d, ov = min - d;
              const aH = grabbed === a, cH = grabbed === c;
              if (aH && cH) continue;
              if (aH) {
                C.x += nx * ov; C.y += ny * ov;
                const vn = C.vx * nx + C.vy * ny; if (vn < 0) { C.vx -= 1.8 * vn * nx; C.vy -= 1.8 * vn * ny; }
              } else if (cH) {
                A.x -= nx * ov; A.y -= ny * ov;
                const vn = A.vx * nx + A.vy * ny; if (vn > 0) { A.vx -= 1.8 * vn * nx; A.vy -= 1.8 * vn * ny; }
              } else {
                A.x -= nx * ov / 2; A.y -= ny * ov / 2; C.x += nx * ov / 2; C.y += ny * ov / 2;
                const rvx = C.vx - A.vx, rvy = C.vy - A.vy, vn = rvx * nx + rvy * ny;
                if (vn < 0) { const imp = -1.7 * vn / 2; A.vx -= imp * nx; A.vy -= imp * ny; C.vx += imp * nx; C.vy += imp * ny; }
              }
            }
          }
        }

        // moods
        state.forEach((_, i) => {
          let m: Mood;
          if (grabbed === i) m = "held";
          else if (happy[i] > 0) { happy[i] -= dt; m = "happy"; }
          else if (squish[i] > 0) { squish[i] -= dt; m = "squish"; }
          else m = "idle";
          setMoodAt(i, m);
        });

        render();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      ballEls.current.forEach((n, i) => { if (n && downHandlers[i]) n.removeEventListener("pointerdown", downHandlers[i]); });
      document.body.style.cursor = "";
    };
  }, []);

  return (
    <div className="lhb-stage" ref={wrap}>
      {BALLS.map((b, i) => (
        <div key={`s${b.id}`} className="lhb-shadow" aria-hidden="true" ref={(n) => { shadowEls.current[i] = n; }} />
      ))}
      {BALLS.map((b, i) => (
        <div
          key={b.id}
          className="lhb-ball"
          ref={(n) => { ballEls.current[i] = n; }}
          role="button"
          aria-label="reins mascot — grab and throw"
        >
          <Mascot id={b.id} from={b.from} to={b.to} mood={moods[i] ?? "idle"} />
        </div>
      ))}
    </div>
  );
}

export function LandingHeroBounce() {
  const lines = HEADLINE.split("\n");
  let n = 0;
  return (
    <section className="lhero">
      <div className="lhero-card lhb-card">
        <svg className="lhb-scene" viewBox="0 0 1200 720" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          <rect width="1200" height="720" fill="#f4eee1" />
          <path d="M0 470 Q 360 405 720 452 T 1200 430 V720 H0 Z" fill="#ece3cf" />
          <path d="M0 545 Q 420 498 820 540 T 1200 524 V720 H0 Z" fill="#e4d8bd" />
          <line x1="0" y1="612" x2="1200" y2="612" stroke="#d7c8a6" strokeWidth="2" />
        </svg>

        <BouncingMascots />

        <div className="lhero-fg">
          <header className="lhero-nav">
            <Link href="/" className="brand"><Mark /> reins</Link>
            <nav className="navlinks">
              <a href="#why">Why</a>
              <a href="#how">How</a>
              <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
              <Link href="/login" className="btn solid">Log in</Link>
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
                          {g === " " ? " " : g}
                        </span>
                      );
                    })}
                  </span>
                ))}
              </h1>

              <div className="lhero-rule" style={{ animationDelay: "1.35s" }} />

              <p className="sub lhero-sub lhero-fade" style={{ animationDelay: "1.6s" }}>
                Every teammate&rsquo;s coding agent already reports what it&rsquo;s doing. Reins turns that
                into one shared, up-to-date view of the work.
              </p>

              <div className="lhero-cta lhero-fade" style={{ animationDelay: "1.82s" }}>
                <Link href="/login" className="btn solid lg">Log in</Link>
                <Link href="/signin?demo=1" className="btn lg">Try the demo</Link>
                <CopyCommand text="npx reins-hook install" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
