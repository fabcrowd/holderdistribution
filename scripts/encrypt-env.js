#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import readline from "node:readline";

const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const envPath = path.resolve(process.cwd(), ".env");
const encPath = path.resolve(process.cwd(), ".env.enc");

function getPassphrase() {
  const fromEnv = process.env.ENV_PASSPHRASE;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write("ENV_PASSPHRASE not set. Enter encryption passphrase: ");
    rl.question("", (answer) => {
      rl.close();
      if (answer && answer.length > 0) resolve(answer);
      else reject(new Error("Passphrase cannot be empty"));
    });
  });
}

async function main() {
  let plaintext;
  try {
    plaintext = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("No .env file found. Copy .env.example to .env and fill in values first.");
      process.exit(1);
    }
    throw err;
  }

  const passphrase = await getPassphrase();
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.concat([salt, iv, encrypted, tag]);
  await fs.writeFile(encPath, out, { mode: 0o600 });

  console.log("Wrote .env.enc. Commit this file; do not commit .env.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
