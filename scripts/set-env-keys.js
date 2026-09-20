#!/usr/bin/env node
/**
 * Decrypt .env.enc, set the given env keys, re-encrypt in place. The counterpart
 * to strip-env-keys.js, and the supported way to add RPC keys — hand-editing a
 * decrypted copy risks leaving plaintext secrets on disk.
 *
 * Values are read from STDIN as NAME=VALUE lines, never from argv: argv is
 * visible to `ps` and lands in shell history and CI logs. Nothing here prints a
 * value — only key names and a masked tail, so a paste error is still
 * diagnosable without exposing the secret.
 *
 * Usage: ENV_PASSPHRASE=... node scripts/set-env-keys.js < keys.txt
 *        (or piped:  printf 'ETH_RPC_1=https://...\n' | ENV_PASSPHRASE=... node scripts/set-env-keys.js)
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { getDecryptedEnv } from "./decrypt-env.js";

const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const encPath = path.resolve(process.cwd(), ".env.enc");

function serializeEnv(env) {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}

async function encryptToFile(plaintext, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  await fs.writeFile(encPath, Buffer.concat([salt, iv, encrypted, tag]), { mode: 0o600 });
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const passphrase = process.env.ENV_PASSPHRASE;
if (!passphrase) {
  console.error("ENV_PASSPHRASE is not set.");
  process.exit(1);
}

const input = await readStdin();
const assignments = [];
for (const line of input.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    console.error(`Ignoring malformed line (expected NAME=VALUE): ${trimmed.slice(0, 12)}…`);
    continue;
  }
  assignments.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
}

if (assignments.length === 0) {
  console.error("No NAME=VALUE pairs on stdin.");
  process.exit(1);
}

const env = await getDecryptedEnv();
if (!env) {
  console.error("Could not decrypt .env.enc");
  process.exit(1);
}

for (const [name, value] of assignments) {
  const action = Object.prototype.hasOwnProperty.call(env, name) ? "Replaced" : "Added";
  env[name] = value;
  // Masked: enough to tell two keys apart, not enough to use one.
  console.log(`${action} ${name} (…${value.slice(-4)})`);
}

await encryptToFile(serializeEnv(env), passphrase);
console.log(`Wrote .env.enc (${assignments.length} key(s) set).`);
