"use client";
import { useEffect, useRef, useState, type ElementType } from "react";

const LIGS = ["ffi", "ffl", "fi", "fl", "ff"];
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

/**
 * A heading whose glyphs blur-in (creed-style) the first time it scrolls into
 * view. Pure CSS animation gated by a class toggled via IntersectionObserver —
 * no animation library. `text` may contain "\n" for explicit line breaks.
 */
export function Reveal({
  text,
  as: Tag = "h2" as ElementType,
  className = "",
  step = 0.03,
  base = 0,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  step?: number;
  base?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) { setShown(true); io.disconnect(); }
      },
      { threshold: 0.25, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const lines = text.split("\n");
  let n = 0;
  return (
    <Tag ref={ref} className={`reveal ${shown ? "reveal-in" : ""} ${className}`}>
      {lines.map((line, li) => (
        <span key={li} className="reveal-line">
          {splitGlyphs(line).map((g, gi) => {
            const i = n++;
            return (
              <span key={gi} className="reveal-g" style={{ animationDelay: `${base + i * step}s` }}>
                {g === " " ? " " : g}
              </span>
            );
          })}
        </span>
      ))}
    </Tag>
  );
}
