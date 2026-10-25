#!/usr/bin/env node
/**
 * scan-solana-flows.js --project <slug> [--limit N]   (scaffold, dry-run)
 * Venue owners = contracts{} entries with role cex/dex. For each:
 * getTokenAccountsByOwner(mint) -> getSignaturesForAddress (newest N) ->
 * getTransaction -> classified deltas -> data/<slug>/solana-flows-sample.json.
 * Publishes nothing under public/data.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectRoleAddresses, projectWorkDir } from "./lib/projects.js";

await loadEnv();
const project = selectPipelineProject("scan-solana-flows", { ported: true });
const chain = (project.config.chains ?? []).find((c) => c.vm === "solana" || c.key === "solana");
if (!chain) {
  console.log("No Solana chain; nothing to do.");
  process.exit(0);
}
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 25;
const venues = projectRoleAddresses(project.config, { roles: ["cex", "dex"] })[chain.key] ?? []; // case-preserved for Solana
const cex = new Set(venues.filter((e) => e.role === "cex").map((e) => e.address));
const dex = new Set(venues.filter((e) => e.role === "dex").map((e) => e.address));
if (cex.size + dex.size === 0) {
  console.log(`${project.slug}: no cex/dex venue addresses in contracts{}; nothing to scan (flows stay unpublished).`);
  process.exit(0);
}

const { configureSolanaChain, getUsableSolanaRpcUrls, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
const { solanaBaseToken } = await import("./lib/solana/adapter.js");
const { mintDeltasByOwner, classifyFlow } = await import("./lib/solana/tokenFlows.js");
configureSolanaChain(chain);
const urls = await getUsableSolanaRpcUrls(chain.key);
const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: chain.key });
const mint = solanaBaseToken(chain).address;

const rows = [];
for (const owner of [...cex, ...dex]) {
  const accts = await call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
  for (const a of accts?.value ?? []) {
    const sigs = await call("getSignaturesForAddress", [a.pubkey, { limit: LIMIT, commitment: "finalized" }]);
    for (const s of sigs ?? []) {
      if (s.err) continue;
      const tx = await call("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
      for (const f of classifyFlow(mintDeltasByOwner(tx, mint), { cex, dex })) rows.push({ signature: s.signature, blockTime: s.blockTime ?? null, ...f });
    }
  }
}
const out = path.resolve(projectWorkDir(project), "solana-flows-sample.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), mint, limit: LIMIT, rows }, null, 2) + "\n");
console.log(`${project.slug}: ${rows.length} classified flow rows -> ${out}`);
