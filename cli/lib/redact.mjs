/**
 * Client-side secret redaction — masks credentials in captured text BEFORE it
 * leaves the machine, so a leaked key never travels the wire or reaches the
 * server at all. The server re-applies the same masking at ingest as a backstop.
 *
 * Dependency-free (Node built-ins only). Keep in sync with server/src/redact.ts.
 * Conservative: masks recognised credential shapes and leaves ordinary content,
 * including hex hashes like git SHAs, untouched.
 */

const MASK = "‹redacted›";

const RULES = [
  {
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replace: () => `‹redacted private key›`,
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: () => MASK,
  },
  {
    re: /\b(sk-(?:proj-|cv-|ant-|or-|live-|test-)?|rk_(?:admin|access|ingest)_|gh[posru]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|glpat-|hf_|shpat_|sk_live_|sk_test_|pk_live_)[A-Za-z0-9_-]{12,}/g,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    re: /\b(api[-_ ]?key|secret(?:[-_ ]?key)?|access[-_ ]?token|client[-_ ]?secret|auth(?:orization)?|bearer|token|password|passwd)\b(\s*(?:[:=]|is|as)\s*)(["']?)([A-Za-z0-9][A-Za-z0-9_\-./+=]{11,})\3/gi,
    replace: (_m, field, sep, q) => `${field}${sep}${q}${MASK}${q}`,
  },
];

/** Mask credentials found in `text`. Returns the input unchanged when empty. */
export function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace);
  return out;
}
