"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A pair of mascots peeking up from behind the footer with a gentle bob. The
 * curious one ducks back down when you touch it; the startled one does a little
 * shake. Two reactions, side by side.
 */

type Peek = {
  id: string;
  from: string;
  to: string;
  face: "curious" | "startled";
  reaction: "duck" | "shake";
  phase: boolean; // start the bob on the opposite beat
};

const PEEKERS: Peek[] = [
  { id: "peekA", from: "#ffe89a", to: "#f0c948", face: "curious", reaction: "duck", phase: false },
  { id: "peekB", from: "#ffd96b", to: "#d9b53e", face: "startled", reaction: "shake", phase: true },
];

function Peeker({ p }: { p: Peek }) {
  const [ducked, setDucked] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [up, setUp] = useState(p.phase);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const id = window.setInterval(() => setUp((u) => !u), 1500);
    return () => window.clearInterval(id);
  }, []);

  const react = () => {
    if (p.reaction === "duck") {
      if (ducked) return;
      setDucked(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDucked(false), 1000);
    } else {
      if (shaking) return;
      setShaking(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShaking(false), 600);
    }
  };

  const ty = ducked ? 120 : up ? 28 : 44;

  return (
    <div
      className={`peek ${shaking ? "peek-shake" : ""}`}
      style={{ transform: `translateY(${ty}px)` }}
      onPointerEnter={react}
      onPointerDown={react}
    >
      <svg viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id={p.id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={p.from} />
            <stop offset="100%" stopColor={p.to} />
          </linearGradient>
        </defs>
        <path d="M16 5C23 5 27 10 27 17C27 24 22 27 16 27C10 27 5 24 5 17C5 10 9 5 16 5Z" fill={`url(#${p.id})`} />
        {p.face === "curious" ? (
          <>
            {/* curious peeking eyes (looking up) with catchlights, gentle smile */}
            <circle cx="13" cy="15.5" r="2.5" fill="#1b1a17" />
            <circle cx="21" cy="15.5" r="2.5" fill="#1b1a17" />
            <circle cx="13.8" cy="14.6" r="0.8" fill="#fff" />
            <circle cx="21.8" cy="14.6" r="0.8" fill="#fff" />
            <path d="M13.5 20.5 Q16 22.4 18.5 20.5" stroke="#1b1a17" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </>
        ) : (
          <>
            {/* startled: wide eyes and a little round mouth */}
            <circle cx="12.8" cy="15.3" r="2.9" fill="#1b1a17" />
            <circle cx="21.2" cy="15.3" r="2.9" fill="#1b1a17" />
            <circle cx="13.7" cy="14.3" r="0.9" fill="#fff" />
            <circle cx="22.1" cy="14.3" r="0.9" fill="#fff" />
            <circle cx="17" cy="21" r="1.7" fill="#1b1a17" />
          </>
        )}
      </svg>
    </div>
  );
}

export function FooterPeek() {
  return (
    <div className="peek-wrap" aria-hidden="true">
      {PEEKERS.map((p) => (
        <Peeker key={p.id} p={p} />
      ))}
    </div>
  );
}
