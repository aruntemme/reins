"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Mark } from "./ui";

const GITHUB = "https://github.com/aruntemme/reins";

/**
 * A small floating header that slides in once you've scrolled past the hero's
 * own nav, and tucks away again at the top. Landing page only.
 */
export function StickyHeader() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 0.6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className={`floatnav ${shown ? "show" : ""}`} aria-hidden={!shown}>
      <Link href="/" className="brand floatnav-brand"><Mark size={22} /> reins</Link>
      <nav className="floatnav-links">
        <a href="#why">Why</a>
        <a href="#how">How</a>
        <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
      </nav>
      <Link href="/dashboard" className="btn solid floatnav-cta">Open dashboard</Link>
    </div>
  );
}
