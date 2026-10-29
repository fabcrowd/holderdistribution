#!/usr/bin/env node
/**
 * dump-wallet-transfers.js
 *
 * Read-only: lists every token transfer that touches a tracked wallet between two
 * dates, so a treasury/council move can be traced to its counterparty instead of
 * inferred from daily category totals. Writes nothing; CSV goes to stdout.
 *
 *  - Tracked wallets = the project's treasury categories (treasury, council,
 *    holdings, escrow by default) from its exclusions file; override with
 *    --categories treasury,council. Both legacy and v3 tokens on every chain.
 *  - Counterparty is labelled from the exclusions and CEX wallet lists, or
 *    "unlabelled" (a destination to decide on, not to assume).
 *  - Needs RPC (ENV_PASSPHRASE-decrypted keys); refuses without it.
 *
 * Usage: node scripts/dump-wallet-transfers.js --project tel --from 2026-10-22 --to 2026-10-28 > transfers.csv
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall } from "./lib/rpc.js";
import { findBlockAtTime } from "./lib/historicalReplay.js";
import { fetchAllTransfers } from "./lib/alchemyTransfers.js";
import { rawToTel, resolveChainTokens } from "./lib/telTokens.js";
import { selectPipelineProject, projectChains, projectClassificationPath } from "./lib/projects.js";
import { categoryAddressMap, exchangeAddressMap } from "./lib/treasuryCexBackfill.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATEGORIES = ["treasury", "council", "holdings", "escrow"];
const DAY_MS = 86_400_000;

const readArg = (flag, fallback = null) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const dayBefore = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const main = async () => {
  const project = selectPipelineProject("dump-wallet-transfers", { ported: true });
  const from = readArg("--from");
  const to = readArg("--to");
  if (!from || !to) fail("Usage: --project <slug> --from YYYY-MM-DD --to YYYY-MM-DD [--categories a,b]");
  if (to >= new Date().toISOString().slice(0, 10)) fail(`--to ${to} must be before today (UTC): the day is not over yet.`);
  if (!process.env.ENV_PASSPHRASE) fail("ENV_PASSPHRASE is not set: refusing to run without decrypted RPC keys.");
  await loadEnv();

  // rpc.js logs pool status to stdout; keep stdout CSV-only.
  const emit = console.log.bind(console);
  console.log = console.error;

  const categories = (readArg("--categories") ?? DEFAULT_CATEGORIES.join(",")).split(",");
  const exclusionsPath = projectClassificationPath(project, "exclusions", ROOT);
  const cexWalletsPath = projectClassificationPath(project, "cexWallets", ROOT);
  const exclusions = exclusionsPath ? await readJson(exclusionsPath) : {};
  const tracked = categoryAddressMap(exclusions, categories);
  const exchanges = exchangeAddressMap(cexWalletsPath ? await readJson(cexWalletsPath) : {});
  if (!tracked.size) fail(`project "${project.slug}" has no wallets in categories: ${categories.join(", ")}.`);

  const labelOf = (address) => {
    if (!address) return "mint/burn";
    const label = exclusions.labels?.[address] ?? exclusions.labels?.[address.toLowerCase()];
    if (label) return `${label.category}:${label.name ?? ""}`;
    if (exchanges.has(address)) return `cex:${exchanges.get(address)}`;
    return "unlabelled";
  };

  const chainConfig = projectChains(project, ROOT);
  emit("date,chain,token,tx,from,from_label,to,to_label,amount,direction");

  for (const [chainKey, cfg] of Object.entries(chainConfig)) {
    const [rpcUrl] = await getUsableRpcUrls(chainKey);
    if (!rpcUrl) fail(`No RPC URL for ${chainKey}`);
    const head = Number(BigInt(await rpcCall(rpcUrl, "eth_blockNumber", [])));
    const timestampOf = async (block) =>
      parseInt((await rpcCall(rpcUrl, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])).timestamp, 16);
    const blockAtEndOf = (date) =>
      findBlockAtTime(Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000), {
        low: Number(cfg.fromBlock),
        high: head,
        getTimestamp: timestampOf,
      });

    const fromBlock = (await blockAtEndOf(dayBefore(from))) + 1;
    const toBlock = await blockAtEndOf(to);
    const t = resolveChainTokens({ ...cfg, key: chainKey });
    const tokens = [{ ...t.legacy, generation: "legacy" }, ...(t.v3 ? [{ ...t.v3, generation: "v3" }] : [])];
    const dayByBlock = new Map();

    for (const token of tokens) {
      const transfers = await fetchAllTransfers(rpcUrl, { fromBlock, toBlock, contractAddress: token.address });
      for (const tr of transfers) {
        const fromTracked = tracked.has(tr.from);
        const toTracked = tracked.has(tr.to);
        if (!fromTracked && !toTracked) continue;
        const block = Number(BigInt(tr.blockNumber));
        if (!dayByBlock.has(block)) {
          dayByBlock.set(block, new Date((await timestampOf(block)) * 1000).toISOString().slice(0, 10));
        }
        const direction = fromTracked && toTracked ? "internal" : fromTracked ? "out" : "in";
        emit(
          [
            dayByBlock.get(block), chainKey, token.generation, tr.transactionHash ?? "",
            tr.from ?? "", labelOf(tr.from), tr.to ?? "", labelOf(tr.to),
            rawToTel(tr.value, token.decimals), direction,
          ].map(csvCell).join(","),
        );
      }
    }
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
