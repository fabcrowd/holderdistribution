#!/usr/bin/env node
/**
 * Decrypt .env.enc, remove the given env key names, re-encrypt in place.
 * Usage: ENV_PASSPHRASE=... node scripts/strip-env-keys.js ETH_RPC_0
 * Never prints secret values.
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

const toRemove = process.argv.slice(2).filter(Boolean);
if (toRemove.length === 0) {
  console.error("Usage: node scripts/strip-env-keys.js KEY_NAME [KEY_NAME...]");
  process.exit(1);
}

const passphrase = process.env.ENV_PASSPHRASE;
if (!passphrase) {
  console.error("ENV_PASSPHRASE is not set.");
  process.exit(1);
}

const env = await getDecryptedEnv();
if (!env) {
  console.error("Could not decrypt .env.enc");
  process.exit(1);
}

let removed = 0;
for (const key of toRemove) {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    delete env[key];
    removed += 1;
    console.log(`Removed ${key}`);
  } else {
    console.log(`Skip ${key} (not present)`);
  }
}

if (removed === 0) {
  console.log("Nothing to change.");
  process.exit(0);
}

await encryptToFile(serializeEnv(env), passphrase);
console.log(`Wrote .env.enc (${removed} key(s) removed).`);
