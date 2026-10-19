#!/usr/bin/env node
/**
 * Print a salted PBKDF2 hash for the forensics gate's FORENSICS_PASSWORD_HASH env var.
 *
 *   printf '%s' 'the password' | node scripts/hash-forensics-password.js
 *
 * Reads the password from stdin (never argv, so it stays out of shell history and
 * `ps`). Output format: pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>
 * Must stay in sync with netlify/functions-src/gateAuth.ts (verifySaltedHash).
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (!password) {
  console.error("No password on stdin.");
  process.exit(1);
}
const iterations = 600_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
console.log(`pbkdf2-sha256$${iterations}$${salt.toString("hex")}$${hash.toString("hex")}`);
