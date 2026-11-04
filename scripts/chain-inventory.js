#!/usr/bin/env node
/**
 * chain-inventory.js — write config/projects/<slug>/chains-inventory.json
 * (onboarding step 1, see scripts/lib/chainInventory.js).
 *
 *   node scripts/detect-token-chains.js --project <slug> --coingecko --out /tmp/d.json
 *   node scripts/chain-inventory.js --project <slug> --discovery /tmp/d.json [--extra rows.json] [--no-supply] [--out <file>] [--check]
 *
 * Network: keyless public RPC only (EVM totalSupply eth_call, Solana
 * getTokenSupply) and CoinGecko's keyless /coins/<id>. 0 Alchemy CU: Alchemy
 * URLs are never used here. --check validates the committed inventory against
 * the config and exits 1 on any error (no network).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveProject, defaultProjectSlug } from "./lib/projects.js";
import { chainExplorerUrl } from "./lib/chainAdapters.js";
import { buildInventory, inventoryRelPath, validateInventory } from "./lib/chainInventory.js";

const arg = (argv, k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function publicSupplies(project) {
  const { getPublicFallbackUrls, rpcCall } = await import("./lib/rpc.js");
  const { solanaPublicUrls } = await import("./lib/solana/rpc.js");
  const { configChainTokens } = await import("./lib/chainInventory.js");
  const out = {};
  for (const c of project.config.chains ?? []) {
    const vm = c.vm ?? "evm";
    out[c.key] = {};
    for (const t of configChainTokens(c)) {
      const urls = vm === "solana" ? solanaPublicUrls(c.key) : getPublicFallbackUrls(c.key);
      for (const u of urls) {
        try {
          if (vm === "solana") {
            const r = await rpcCall(u, "getTokenSupply", [t.address]);
            out[c.key][t.address] = Number(r?.value?.uiAmountString ?? r?.value?.uiAmount);
          } else {
            const hex = await rpcCall(u, "eth_call", [{ to: t.address, data: "0x18160ddd" }, "latest"]);
            out[c.key][t.address] = Number(BigInt(hex)) / 10 ** (t.decimals ?? 18);
          }
          break;
        } catch {
          /* next public endpoint */
        }
      }
    }
  }
  return out;
}

async function coingeckoFacts(id) {
  if (!id) return null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { id, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { id, platforms: j.platforms ?? {}, circulatingSupply: j.market_data?.circulating_supply ?? null, totalSupply: j.market_data?.total_supply ?? null, source: `https://api.coingecko.com/api/v3/coins/${id}` };
  } catch (err) {
    return { id, error: String(err?.message ?? err) };
  }
}

export async function main(argv = process.argv.slice(2), { root = process.cwd(), logger = console } = {}) {
  const slug = arg(argv, "--project") ?? process.env.HD_PROJECT ?? defaultProjectSlug(root);
  const project = resolveProject(slug, root);
  const rel = arg(argv, "--out") ?? inventoryRelPath(slug);
  if (argv.includes("--check")) {
    const file = path.resolve(root, rel);
    const inv = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const errors = validateInventory({ slug, ...project.config }, inv);
    for (const e of errors) logger.error(`[chain-inventory] ${slug}: ${e}`);
    if (!errors.length) logger.log(`[chain-inventory] ${slug}: ok (${inv.chains.length} chains)`);
    return errors;
  }
  const discovery = arg(argv, "--discovery") ? JSON.parse(fs.readFileSync(arg(argv, "--discovery"), "utf8")) : null;
  const extra = arg(argv, "--extra") ? JSON.parse(fs.readFileSync(arg(argv, "--extra"), "utf8")) : [];
  const supplies = argv.includes("--no-supply") ? {} : await publicSupplies(project);
  const coingecko = argv.includes("--no-coingecko") ? null : await coingeckoFacts(project.config?.supply?.coingeckoId ?? project.config?.coingeckoId);
  const inv = buildInventory({ project, discovery, supplies, coingecko, extra, explorerUrl: (c, a) => chainExplorerUrl(c, "token", a) });
  fs.mkdirSync(path.dirname(path.resolve(root, rel)), { recursive: true });
  fs.writeFileSync(path.resolve(root, rel), `${JSON.stringify(inv, null, 2)}\n`);
  const errors = validateInventory({ slug, ...project.config }, inv);
  logger.log(`[chain-inventory] wrote ${rel}: ${inv.chains.map((r) => `${r.chain}=${r.status}`).join(" ")}`);
  for (const e of errors) logger.warn(`[chain-inventory] ${slug}: ${e}`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((errors) => process.exit(errors.length ? 1 : 0), (err) => {
    console.error(`[chain-inventory] ${err.message}`);
    process.exit(2);
  });
}
