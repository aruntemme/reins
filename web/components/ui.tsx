"use client";
import Link from "next/link";
import { UserMenu } from "@/components/user-menu";

export function Mark({ size = 26 }: { size?: number }) {
  // reins mascot: a friendly gradient blob with eyes.
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="reinsBlob" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffd96b" />
          <stop offset="100%" stopColor="#e9c245" />
        </linearGradient>
      </defs>
      <path
        d="M16 5C23 5 27 10 27 17C27 24 22 27 16 27C10 27 5 24 5 17C5 10 9 5 16 5Z"
        fill="url(#reinsBlob)"
      />
      <circle cx="13" cy="16" r="2" fill="#1b1a17" />
      <circle cx="21" cy="16" r="2" fill="#1b1a17" />
      <path d="M13 21C15 22.5 17 22.5 19 21" stroke="#1b1a17" strokeWidth="1.6" strokeLinecap="round" fill="none" />
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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
  const parts = name.replace(/@.*/, "").split(/[.\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Avatar({ name, i = 0 }: { name: string; i?: number }) {
  const hues = ["#1b1a17", "#2f6df0", "#3f9d63", "#d98b3a", "#7a5af0", "#c0397a"];
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
