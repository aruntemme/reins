"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A mascot that peeks up from behind the footer with a gentle bob. Touch it and
 * it ducks back down behind the footer, then pops back up a second later.
 */
export function FooterPeek() {
  const [ducked, setDucked] = useState(false);
  const [up, setUp] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const id = window.setInterval(() => setUp((u) => !u), 1500);
    return () => window.clearInterval(id);
  }, []);

  const duck = () => {
    if (ducked) return;
    setDucked(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDucked(false), 1000);
  };

  const ty = ducked ? 120 : up ? 28 : 44;

  return (
    <div className="peek-wrap" aria-hidden="true">
      <div
        className="peek"
        style={{ transform: `translateY(${ty}px)` }}
        onPointerEnter={duck}
        onPointerDown={duck}
      >
        <svg viewBox="0 0 32 32" fill="none">
          <defs>
            <linearGradient id="peekBlob" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffe89a" />
              <stop offset="100%" stopColor="#f0c948" />
            </linearGradient>
          </defs>
          <path d="M16 5C23 5 27 10 27 17C27 24 22 27 16 27C10 27 5 24 5 17C5 10 9 5 16 5Z" fill="url(#peekBlob)" />
          {/* curious peeking eyes (looking up) with catchlights */}
          <circle cx="13" cy="15.5" r="2.5" fill="#1b1a17" />
          <circle cx="21" cy="15.5" r="2.5" fill="#1b1a17" />
          <circle cx="13.8" cy="14.6" r="0.8" fill="#fff" />
          <circle cx="21.8" cy="14.6" r="0.8" fill="#fff" />
          <path d="M13.5 20.5 Q16 22.4 18.5 20.5" stroke="#1b1a17" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </svg>
      </div>
    </div>
  );
}
