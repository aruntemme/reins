"use client";
import Link from "next/link";

export function Mark({ size = 26 }: { size?: number }) {
  // Abstract "reins" mark: two reins converging to a ring (control point).
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 26 26" fill="none">
      <rect width="26" height="26" rx="7" fill="#1b1a17" />
      <path d="M7 6.5C7 13 9.5 16 13 16.5" stroke="#e9c245" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19 6.5C19 13 16.5 16 13 16.5" stroke="#faf8f4" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="13" cy="18.5" r="2.4" stroke="#e9c245" strokeWidth="1.8" />
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
