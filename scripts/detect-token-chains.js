#!/usr/bin/env node
/**
 * detect-token-chains.js — advisory chain discovery for a mapped project.
 *
 *   node scripts/detect-token-chains.js --project <slug> [--coingecko] [--out <file>]
 *   node scripts/detect-token-chains.js --address 0x… --chain ethereum --ticker ABC [--coingecko]
 *   node scripts/detect-token-chains.js --address <base58 mint> --chain solana --ticker ABC [--coingecko]
 *     (questionnaire step, before config/projects/<slug>.json exists)
 *
 * A Solana mint in CoinGecko's platforms map is reported as a Solana candidate
 * (case preserved) and confirmed against the mint over the public Solana RPC.
 * Every candidate suggests bridge "native" and must be confirmed by a human.
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
import { isSolanaAddress } from "./lib/address.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

let slug;
let config;
const address = flag("--address");
if (address) {
  const chain = (flag("--chain") ?? (isSolanaAddress(address) ? "solana" : "ethereum")).toLowerCase();
  if (chain === "solana") {
    // base58 is case-sensitive: never lowercased.
    if (!isSolanaAddress(address)) throw new Error(`--address must be a base58 Solana mint with --chain solana, got ${address}`);
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`--address must be a 0x… contract address (or a base58 mint with --chain solana), got ${address}`);
  }
  slug = null;
  config = {
    ticker: flag("--ticker") ?? "",
    chains: [{ key: chain, ...(chain === "solana" ? { vm: "solana" } : {}), origin: true, tokens: [{ address, status: "canonical" }] }],
  };
} else {
  slug = parseProjectArg(argv);
  config = resolveProject(slug).config;
  configureProjectRpc(config);
}

// Confirms a CoinGecko-listed Solana mint on-chain (public RPC, read-only).
// Loaded lazily: only touched when a Solana mint is actually listed.
async function solanaProbe(mint) {
  const [{ getUsableSolanaRpcUrls, solanaCallWithFailover }, { fetchMintMetadata }] = await Promise.all([
    import("./lib/solana/rpc.js"),
    import("./lib/solana/metadata.js"),
  ]);
  try {
    const urls = await getUsableSolanaRpcUrls("solana", { logger: { log() {}, warn() {} } });
    const meta = await fetchMintMetadata((m, p) => solanaCallWithFailover(urls, m, p, { chainKey: "solana" }), mint);
    return { status: "found", symbol: meta.symbol, decimals: meta.decimals, program: meta.program };
  } catch (error) {
    return /not found|not a mint|not the SPL Token/i.test(error.message) ? { status: "not-found" } : { status: "rpc-error", error: error.message };
  }
}

const outIdx = argv.indexOf("--out");
const report = await detectTokenChains({
  config,
  call: rpcCall,
  urlsFor: (key) => getPublicFallbackUrls(key),
  useCoingecko: argv.includes("--coingecko"),
  solanaProbe,
});
const json = `${JSON.stringify({ project: slug, ...report }, null, 2)}\n`;
if (outIdx >= 0 && argv[outIdx + 1]) await fs.writeFile(argv[outIdx + 1], json, "utf8");
process.stdout.write(json);
