/**
 * Shared non-retail address set for holder pipeline consumers.
 *
 * Merges config/exclusions.json (addresses + chains.*.addresses),
 * config/cex-wallets.json, and config/dex-contracts.json (pools + routers)
 * into one Set so RPC / lite / transitions / outflows never diverge.
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const EXCLUSIONS_PATH = path.resolve(ROOT, "config/exclusions.json");
const CEX_CONFIG_PATH = path.resolve(ROOT, "config/cex-wallets.json");
const DEX_CONFIG_PATH = path.resolve(ROOT, "config/dex-contracts.json");

export const normalizeAddress = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null;
};

const readJson = async (absolutePath) => {
  const content = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(content);
};

const addAddress = (set, value) => {
  const normalized = normalizeAddress(value);
  if (normalized) set.add(normalized);
  return normalized;
};

/**
 * Loads CEX wallet addresses from the canonical config source.
 * @returns {Promise<Set<string>>}
 */
export const loadCexAddressSet = async (cexPath = CEX_CONFIG_PATH) => {
  const set = new Set();
  try {
    const data = await readJson(cexPath);
    for (const wallet of data?.wallets ?? []) {
      addAddress(set, wallet?.address);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return set;
};

/**
 * Loads DEX pool + router addresses from dex-contracts.json.
 * @returns {Promise<Set<string>>}
 */
export const loadDexAddressSet = async (dexPath = DEX_CONFIG_PATH) => {
  const set = new Set();
  try {
    const data = await readJson(dexPath);
    for (const pool of data?.pools ?? []) addAddress(set, pool?.address);
    for (const router of data?.routers ?? []) addAddress(set, router?.address);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return set;
};

/**
 * Builds the full non-retail exclusion set.
 * @param {{ exclusionsPath?: string, cexPath?: string, dexPath?: string }} [paths]
 * @returns {Promise<{ set: Set<string>, sizes: { exclusions: number, cex: number, dex: number, total: number } }>}
 */
export const loadNonRetailSet = async (paths = {}) => {
  const exclusionsPath = paths.exclusionsPath ?? EXCLUSIONS_PATH;
  const cexPath = paths.cexPath ?? CEX_CONFIG_PATH;
  const dexPath = paths.dexPath ?? DEX_CONFIG_PATH;

  const set = new Set();
  const exclusions = await readJson(exclusionsPath);
  for (const address of exclusions.addresses ?? []) addAddress(set, address);
  for (const chainInfo of Object.values(exclusions.chains ?? {})) {
    for (const address of chainInfo?.addresses ?? []) addAddress(set, address);
  }
  const afterExclusions = set.size;

  const cexSet = await loadCexAddressSet(cexPath);
  const cexTotal = cexSet.size;
  for (const address of cexSet) set.add(address);

  const dexSet = await loadDexAddressSet(dexPath);
  const dexTotal = dexSet.size;
  for (const address of dexSet) set.add(address);

  return {
    set,
    sizes: {
      exclusions: afterExclusions,
      // Gross config sizes (not marginal adds) — DEX pools/routers usually
      // already sit in exclusions.addresses, so a delta would always read 0
      // and look like the DEX merge failed.
      cex: cexTotal,
      dex: dexTotal,
      total: set.size,
    },
  };
};

export const createNonRetailChecker = (nonRetailSet) => (address) => {
  const normalized = normalizeAddress(address);
  return Boolean(normalized) && nonRetailSet.has(normalized);
};
