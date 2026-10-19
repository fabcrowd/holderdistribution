/**
 * Server-side auth helpers for the forensics gate (netlify/functions-src/forensics-gate.ts).
 *
 * Password checks, in order (any match unlocks):
 *   1. FORENSICS_PASSWORD_HASH  — salted PBKDF2 hash, "pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>".
 *      Generate with `node scripts/hash-forensics-password.js` (reads the password from stdin).
 *   2. FORENSICS_PASSWORD       — plaintext env var (compared via SHA-256 digests, constant time).
 *   3. The legacy unsalted SHA-256 constant in src/lib/forensicsPasswordHash.ts — kept so the
 *      current password keeps working. Disable it with FORENSICS_DISABLE_LEGACY_HASH=1 once (1)
 *      is set in Netlify. See docs/FORENSICS.md → "Rotating to a salted hash".
 * All digest comparisons use crypto.timingSafeEqual.
 */
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { FORENSICS_PASSWORD_SHA256 } from "../../src/lib/forensicsPasswordHash.ts";

type Env = Record<string, string | undefined>;

export const DEFAULT_ALLOWED_ORIGINS = ["https://holderdistribution.com", "https://www.holderdistribution.com"];
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888",
  "http://127.0.0.1:8888",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
];

const trimOrigin = (u: string | undefined) => {
  if (!u) return null;
  try {
    return new URL(u.trim()).origin;
  } catch {
    return null;
  }
};

/** Site origins allowed to call the gate from a browser. */
export function allowedOrigins(env: Env = process.env): Set<string> {
  const set = new Set(DEFAULT_ALLOWED_ORIGINS);
  // Netlify sets these at runtime for the site's own primary / deploy URLs.
  for (const key of ["URL", "DEPLOY_URL", "DEPLOY_PRIME_URL"]) {
    const o = trimOrigin(env[key]);
    if (o) set.add(o);
  }
  for (const extra of (env.FORENSICS_ALLOWED_ORIGINS ?? "").split(",")) {
    const o = trimOrigin(extra);
    if (o) set.add(o);
  }
  if (env.NETLIFY_DEV === "true" || env.CONTEXT === "dev" || env.FORENSICS_ALLOW_LOCALHOST === "1") {
    for (const o of LOCAL_DEV_ORIGINS) set.add(o);
  }
  return set;
}

/** No Origin header (curl, server-to-server) is allowed: CORS is a browser control; the password still applies. */
export const originAllowed = (origin: string | undefined, env: Env = process.env) =>
  !origin || allowedOrigins(env).has(origin);

export function corsHeaders(origin: string | undefined, env: Env = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins(env).has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time equality for two digests (different lengths → false, still constant work). */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const PBKDF2_PREFIX = "pbkdf2-sha256";

export function hashPassword(password: string, { iterations = 600_000, salt = randomBytes(16) } = {}): string {
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `${PBKDF2_PREFIX}$${iterations}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifySaltedHash(password: string, encoded: string): boolean {
  const [scheme, iter, saltHex, hashHex] = encoded.trim().split("$");
  const iterations = Number(iter);
  if (scheme !== PBKDF2_PREFIX || !Number.isInteger(iterations) || iterations < 10_000 || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, expected.length || 32, "sha256");
  return digestsEqual(actual, expected);
}

export function passwordMatches(candidate: string | undefined, env: Env = process.env): boolean {
  if (!candidate || typeof candidate !== "string" || candidate.length > 256) return false;
  let ok = false;
  if (env.FORENSICS_PASSWORD_HASH) ok = verifySaltedHash(candidate, env.FORENSICS_PASSWORD_HASH) || ok;
  const digest = sha256(candidate);
  if (env.FORENSICS_PASSWORD) ok = digestsEqual(digest, sha256(env.FORENSICS_PASSWORD)) || ok;
  if (env.FORENSICS_DISABLE_LEGACY_HASH !== "1") {
    ok = digestsEqual(digest, Buffer.from(FORENSICS_PASSWORD_SHA256, "hex")) || ok;
  }
  return ok;
}

/** Fixed-window limiter keyed by client IP (per function instance — best effort, not global). */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts a hit; returns seconds to wait when over the limit. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    const rec = this.hits.get(key);
    if (!rec || now > rec.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return { allowed: true, retryAfter: 0 };
    }
    rec.count++;
    return rec.count > this.max
      ? { allowed: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) }
      : { allowed: true, retryAfter: 0 };
  }

  blocked(key: string, now = Date.now()): { blocked: boolean; retryAfter: number } {
    const rec = this.hits.get(key);
    if (!rec || now > rec.resetAt || rec.count < this.max) return { blocked: false, retryAfter: 0 };
    return { blocked: true, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (now > v.resetAt) this.hits.delete(k);
  }
}
