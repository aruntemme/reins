"use client";
import { useSyncExternalStore } from "react";
import { readTheme, setTheme, subscribeTheme, type Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  {
    value: "light",
    label: "Light",
    icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  },
  {
    value: "dark",
    label: "Dark",
    icon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  },
  {
    value: "system",
    label: "System",
    icon: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  },
];

/**
 * Light / Dark / System, as a row of menuitemradio buttons for the account menu.
 * Reads the stored choice through useSyncExternalStore: the server snapshot is
 * "system", so it never causes a hydration mismatch, and it stays in sync with
 * other tabs. Styles: .um-theme* in user-menu.css.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  return (
    <div role="group" aria-label="Theme" className="um-theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="menuitemradio"
          aria-checked={theme === o.value}
          className="um-theme-opt"
          onClick={() => setTheme(o.value)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {o.icon}
          </svg>
          {o.label}
        </button>
      ))}
    </div>
  );
}
