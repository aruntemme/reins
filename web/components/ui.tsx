"use client";
import Link from "next/link";
import { UserMenu } from "@/components/user-menu";

export function Mark({ size = 26, tone = "tile" }: { size?: number; tone?: "tile" | "plain" }) {
  // Two halves of a link held together: the rein between agents. "tile" sits on a
  // sky square (app chrome); "plain" is the bare glyph in currentColor (on the sky field).
  const glyph = (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M5 15a4 4 0 0 1 0-8h3" />
      <path d="M19 9a4 4 0 0 1 0 8h-3" />
      <path d="M8 12h8" />
    </g>
  );
  if (tone === "plain") {
    return (
      <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        {glyph}
      </svg>
    );
  }
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0593C6" />
      <g transform="translate(4 4)" color="#FCFFFF">
        {glyph}
      </g>
    </svg>
  );
}

export function TopBar({
  live,
  right,
  hideLive,
  brandHref = "/",
}: {
  live?: boolean;
  right?: React.ReactNode;
  hideLive?: boolean;
  brandHref?: string;
}) {
  return (
    <div className="topbar">
      <div className="wrap">
        <Link href={brandHref} className="brand">
          <Mark />
          reins
        </Link>
        <div className="topbar-right">
          {right}
          {!hideLive && (
            <span className="livechip">
              <span className={`dot ${live ? "on" : ""}`} />
              {live ? "live" : "offline"}
            </span>
          )}
          {/* Renders only for real account sessions; hidden for token sessions. */}
          <UserMenu />
        </div>
      </div>
    </div>
  );
}

export function initials(name: string): string {
  // Letters and digits only, so "Dev (alice)" gives "DA", not "D(".
  const parts = name.replace(/@.*/, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Avatar({ name, i = 0 }: { name: string; i?: number }) {
  // Navy and blues only: pink and amber carry meaning (overlap, blocked) elsewhere.
  const hues = ["#0B2540", "#0478A8", "#0A2C52", "#3C5468", "#035E84", "#566E81"];
  return (
    <span className="av" style={{ background: hues[i % hues.length] }} title={name}>
      {initials(name)}
    </span>
  );
}

export const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "active", cls: "active" },
  blocked: { label: "blocked", cls: "blocked" },
  idle: { label: "idle", cls: "idle" },
};
