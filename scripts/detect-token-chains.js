#!/usr/bin/env node
/**
 * detect-token-chains.js — advisory chain discovery for a mapped project.
 *
 *   node scripts/detect-token-chains.js --project <slug> [--coingecko] [--out <file>]
 *   node scripts/detect-token-chains.js --address 0x… --chain ethereum --ticker ABC [--coingecko]
 *     (questionnaire step, before config/projects/<slug>.json exists)
 *
 * Checks every candidate EVM chain (scripts/lib/tokenChains.js) the project's
 * config does NOT already list, using free public RPCs (same-address probe +
 * symbol/decimals) and, with --coingecko, CoinGecko's keyless contract lookup
 * for bridged copies at other addresses. Prints a JSON report; never edits
 * config/projects/<slug>.json — a human confirms each candidate (bridge docs,
 * explorer "token tracker" page) before adding it to chains[]. No paid APIs.
 */
import fs from "node:fs/promises";
import { parseProjectArg, resolveProject } from "./lib/projects.js";
import { configureProjectRpc, getPublicFallbackUrls, rpcCall } from "./lib/rpc.js";
import { detectTokenChains } from "./lib/tokenChains.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

let slug;
let config;
const address = flag("--address");
if (address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`--address must be a 0x… contract address, got ${address}`);
  const chain = (flag("--chain") ?? "ethereum").toLowerCase();
  slug = null;
  config = {
    ticker: flag("--ticker") ?? "",
    chains: [{ key: chain, origin: true, tokens: [{ address, status: "canonical" }] }],
  };
} else {
  slug = parseProjectArg(argv);
  config = resolveProject(slug).config;
  configureProjectRpc(config);
}

const outIdx = argv.indexOf("--out");
const report = await detectTokenChains({
  config,
  call: rpcCall,
  urlsFor: (key) => getPublicFallbackUrls(key),
  useCoingecko: argv.includes("--coingecko"),
});
const json = `${JSON.stringify({ project: slug, ...report }, null, 2)}\n`;
if (outIdx >= 0 && argv[outIdx + 1]) await fs.writeFile(argv[outIdx + 1], json, "utf8");
process.stdout.write(json);
