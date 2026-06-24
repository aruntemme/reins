import { AuthError } from "./api";

/** In a page's load() catch: bounce to /signin on auth failure, rethrow otherwise. */
export function handleAuth(e: unknown): boolean {
  if (e instanceof AuthError) {
    if (typeof window !== "undefined" && window.location.pathname !== "/signin") {
      window.location.href = "/signin";
    }
    return true;
  }
  return false;
}
