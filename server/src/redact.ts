/**
 * Best-effort secret redaction for captured agent text.
 *
 * Applied at ingest so a leaked credential never lands in the event store and is
 * never handed to the LLM (which would otherwise echo it into a timeline or
 * "decided" entry). Conservative by design: it masks recognised credential
 * shapes — provider API keys, PEM private keys, JWTs, and `key = "secret"`
 * assignments — and leaves ordinary content alone, including hex hashes such as
 * 0G Storage root hashes, which must stay readable.
 *
 * Keep this in sync with cli/lib/redact.mjs (the client-side mirror).
 */

const MASK = "‹redacted›"; // ‹redacted›

const RULES: { re: RegExp; replace: (...g: string[]) => string }[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/…)
  {
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replace: () => `‹redacted private key›`,
  },
  // JWTs: header.payload.signature
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: () => MASK,
  },
  // Provider-prefixed API keys / tokens — keep the scheme, mask the secret body.
  {
    re: /\b(sk-(?:proj-|cv-|ant-|or-|live-|test-)?|rk_(?:admin|access|ingest)_|gh[posru]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|glpat-|hf_|shpat_|sk_live_|sk_test_|pk_live_)[A-Za-z0-9_-]{12,}/g,
    replace: (_m: string, prefix: string) => `${prefix}${MASK}`,
  },
  // key = "secret" / token: '…' / password is … — value must look secret-ish
  // (>=12 chars). Keeps the field name and quoting so the line still reads.
  {
    re: /\b(api[-_ ]?key|secret(?:[-_ ]?key)?|access[-_ ]?token|client[-_ ]?secret|auth(?:orization)?|bearer|token|password|passwd)\b(\s*(?:[:=]|is|as)\s*)(["']?)([A-Za-z0-9][A-Za-z0-9_\-./+=]{11,})\3/gi,
    replace: (_m: string, field: string, sep: string, q: string) => `${field}${sep}${q}${MASK}${q}`,
  },
];

/** Mask credentials found in `text`. Returns the input unchanged when empty. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace as (substring: string, ...args: string[]) => string);
  return out;
}
