import { AuthError } from "./api";

/** Send the browser to /login, carrying the current page as ?next= so a deep link survives sign-in. */
export function toLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login") return;
  const here = pathname + search;
  window.location.href = here === "/" || here === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(here)}`;
}

/** In a page's load() catch: bounce to /login on auth failure, rethrow otherwise. */
export function handleAuth(e: unknown): boolean {
  if (e instanceof AuthError) {
    // Accounts are the primary human entry point now, so send people to /login
    // rather than the token-paste /signin page when their session is missing.
    toLogin();
    return true;
  }
  return false;
}

/**
 * Validate a ?next= redirect target: only same-origin paths are honoured, so a
 * crafted link cannot bounce someone off-site after they sign in.
 */
export function safeNext(v: string | null): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || typeof window === "undefined") {
    return "/dashboard";
  }
  // The URL parser also drops tabs/newlines ("/\t/evil.com" → "//evil.com"), so
  // confirm the resolved origin is still ours.
  try {
    const u = new URL(v, window.location.origin);
    if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
  } catch { /* fall through */ }
  return "/dashboard";
}
