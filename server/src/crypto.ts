/**
 * Symmetric encryption for secrets at rest (LLM provider API keys).
 *
 * Keys are encrypted with AES-256-GCM before they ever touch the DB, so a stolen
 * database file alone never yields a usable provider credential. The master key
 * comes from REINS_SECRET_KEY (env) or, for zero-config local runs, a 32-byte key
 * auto-generated once into the gitignored ./.reins-secret file. The on-disk key
 * is run through scrypt with a fixed context salt to derive the 256-bit AES key.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CONTEXT = "reins:provider-secret:v1"; // scrypt salt — domain-separates the key

let _key: Buffer | null = null;

/** Resolve (and cache) the 256-bit AES key derived from the master secret. */
function key(): Buffer {
  if (_key) return _key;
  _key = scryptSync(masterSecret(), CONTEXT, 32);
  return _key;
}

/**
 * Location of the auto-generated key file: alongside the DB (REINS_DB). This way
 * it lands on the same persistent volume as the database in production (so it
 * survives container rebuilds) and in /tmp during tests — never the repo tree.
 */
function secretFilePath(): string {
  const dbPath = process.env.REINS_DB?.trim() || "./reins.db";
  return resolve(dirname(resolve(process.cwd(), dbPath)), ".reins-secret");
}

/** The raw master secret: REINS_SECRET_KEY, else a persisted local key file. */
function masterSecret(): string {
  const fromEnv = process.env.REINS_SECRET_KEY?.trim();
  if (fromEnv) return fromEnv;
  const p = secretFilePath();
  try {
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
    const generated = randomBytes(32).toString("hex");
    writeFileSync(p, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Read-only FS and no env key: fall back to an ephemeral process key so the
    // server still runs. Secrets won't survive a restart — surface loudly.
    console.error(
      "[crypto] REINS_SECRET_KEY not set and ./.reins-secret unwritable — " +
        "using an ephemeral key; stored provider keys will not decrypt after restart."
    );
    const ephemeral = randomBytes(32).toString("hex");
    process.env.REINS_SECRET_KEY = ephemeral;
    return ephemeral;
  }
}

/** Encrypt plaintext -> base64(iv | tag | ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Decrypt base64(iv | tag | ciphertext) -> plaintext. Returns "" on failure.
 *
 * A failure here almost always means the master key changed (REINS_SECRET_KEY
 * rotated, or a lost ./.reins-secret regenerated) so a previously-stored key no
 * longer decrypts. That would silently drop the pipeline to degraded mode, so we
 * log it loudly rather than fail in the dark. Empty input is not an error.
 */
export function decryptSecret(blob: string): string {
  if (!blob) return "";
  try {
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e: any) {
    console.error(
      "[crypto] failed to decrypt a stored secret — the master key likely changed " +
        "(REINS_SECRET_KEY rotated or .reins-secret lost). Re-enter the provider API key. " +
        `(${e?.message ?? e})`
    );
    return "";
  }
}
