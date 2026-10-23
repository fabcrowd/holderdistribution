#!/usr/bin/env node
/**
 * Derive public/data/chain-status.json from public/data/holders-checkpoint.json.
 * Run by the holders pipeline after it saves the checkpoint, and by `prebuild`
 * so every deploy ships a chain-status.json that matches its checkpoint.
 * Keyless and offline: it only reads the committed checkpoint.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildChainStatus } from "./lib/chainStatus.js";

const DATA_DIR = path.resolve(process.cwd(), "public/data");

export async function writeChainStatus(dataDir = DATA_DIR) {
  let checkpoint;
  try {
    checkpoint = JSON.parse(await fs.readFile(path.join(dataDir, "holders-checkpoint.json"), "utf8"));
  } catch (err) {
    console.warn(`write-chain-status: no readable holders-checkpoint.json (${err?.code ?? err?.message}); leaving chain-status.json as is.`);
    return null;
  }
  const status = buildChainStatus(checkpoint);
  await fs.writeFile(path.join(dataDir, "chain-status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await writeChainStatus();
  if (s) console.log(`chain-status.json: ${Object.entries(s.chains).map(([k, v]) => `${k}@${v.lastBlock}`).join(", ")}`);
}
