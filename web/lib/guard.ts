import { AuthError } from "./api";

/** In a page's load() catch: bounce to /login on auth failure, rethrow otherwise. */
export function handleAuth(e: unknown): boolean {
  if (e instanceof AuthError) {
    // Accounts are the primary human entry point now, so send people to /login
    // rather than the token-paste /signin page when their session is missing.
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return true;
  }
  return false;
}
