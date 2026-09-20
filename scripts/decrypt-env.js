#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const encPath = path.resolve(process.cwd(), ".env.enc");

/**
 * Parse .env-format string into key-value object. Skips empty lines and # comments.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseEnvText(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    out[key] = value;
  }
  return out;
}

/**
 * Decrypt .env.enc and return env as object. Caller can set process.env from this.
 * @returns {Promise<Record<string, string> | null>} Env object or null if ENV_PASSPHRASE not set or file missing.
 */
export async function getDecryptedEnv() {
  const passphrase = process.env.ENV_PASSPHRASE;
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    return null;
  }
  let buf;
  try {
    buf = await fs.readFile(encPath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error(".env.enc is too short or corrupted");
  }
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN, buf.length - TAG_LEN);

  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return parseEnvText(plaintext);
}

/**
 * Apply decrypted env to process.env (mutates process.env).
 * @returns {Promise<boolean>} true if env was loaded from .env.enc, false otherwise.
 */
export async function loadDecryptedEnv() {
  const env = await getDecryptedEnv();
  if (!env) return false;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  return true;
}

async function main() {
  const env = await getDecryptedEnv();
  if (!env) {
    if (!process.env.ENV_PASSPHRASE) {
      console.error("ENV_PASSPHRASE is not set.");
      process.exit(1);
    }
    console.error(".env.enc not found.");
    process.exit(1);
  }
  for (const [key, value] of Object.entries(env)) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
