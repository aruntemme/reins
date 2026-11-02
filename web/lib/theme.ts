// Light / dark / system theme. The palettes live in app/globals.css as
// light-dark() pairs; all this module does is set <html data-theme> to
// "light" or "dark" (forced) or remove it ("system": follow the OS).

export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "reins-theme";

const isForced = (v: unknown): v is "light" | "dark" => v === "light" || v === "dark";

/**
 * Runs inline in <head> (app/layout.tsx) before the body is parsed, so the first
 * paint already has the stored theme: no flash. Kept tiny and self-contained;
 * storage can throw (private mode, blocked site data), in which case the page
 * simply follows the OS.
 */
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isForced(v) ? v : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (isForced(theme)) root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
}

const listeners = new Set<() => void>();

/** Store and apply a theme, and tell every subscriber (other toggles on the page). */
export function setTheme(theme: Theme): void {
  apply(theme);
  try {
    if (isForced(theme)) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* not persisted; still applied for this page view */
  }
  listeners.forEach((l) => l());
}

/** For useSyncExternalStore: changes from this tab, and from other tabs via `storage`. */
export function subscribeTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    apply(readTheme());
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}
