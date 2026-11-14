/**
 * The sender set of the Hedera wallet-flows report and ledger: the project-controlled treasury accounts
 * (classification.exclusions, category "treasury") without the network system accounts.
 *
 * 0.0.98 (fee collection), 0.0.800 (staking rewards) and 0.0.801 (node rewards) are touched by a large share of
 * all network transactions and pay protocol rewards, not project disbursements. They stay treasury for supply
 * but are never traced: the registry lists them under `notTraced` and the report says so. HEDERA_VOLUME_EXCLUDED
 * adds accounts left out for a measured request volume.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { projectClassificationPath } from "../projects.js";
import { parseHederaAddress } from "./address.js";
import { HEDERA_NETWORK_ACCOUNTS } from "./treasury.js";

/** Bump when the scan or the stored event shape changes; a stored scan then rebuilds. */
export const WALLET_SCAN_VERSION = 1;
export const NOT_TRACED_REASON = "Network system account: its payouts are protocol rewards or fees, not project disbursements, so they are not traced.";
const NETWORK_IDS = new Set(HEDERA_NETWORK_ACCOUNTS.map((a) => `0.0.${a.num}`));

/**
 * Treasury-range accounts that are not traced for a measured reason. 0.0.54 is a network administration account that
 * holds about 100 HBAR and pays for file-update bursts: sampled on 2026-11-13 it showed 100 records inside one
 * second on the days it was busy, an estimated 5.6 million records (about 56,000 mirror pages) in 90 days, all
 * FILEAPPEND records with no HBAR leg, its only transfers being 8-9 tinybar. The brief's limit for one account is
 * about 20,000 pages, so it stays treasury for supply and is listed under notTraced until the owner decides.
 */
export const HEDERA_VOLUME_EXCLUDED = Object.freeze([
  {
    address: "0.0.54",
    reason: "Network administration account (about 100 HBAR): an estimated 5.6 million file-update records with no HBAR movement in 90 days (about 56,000 mirror pages, over the 20,000-page limit for one account), so it is not traced. Owner decision pending.",
  },
]);
const VOLUME_EXCLUDED = new Map(HEDERA_VOLUME_EXCLUDED.map((a) => [a.address, a.reason]));
const idNumber = (id) => BigInt(id.slice(4));
export const compareIds = (a, b) => (idNumber(a) < idNumber(b) ? -1 : idNumber(a) > idNumber(b) ? 1 : 0);

/** Treasury rows of the project's exclusions file: { traced: [{ address, name }], notTraced: [{ address, name, reason }] }. */
export function hederaTreasurySplit(project, root = process.cwd()) {
  const file = projectClassificationPath(project, "exclusions", root);
  if (!file) throw new Error(`${project.slug}: no classification.exclusions file; the Hedera treasury accounts come from it`);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const traced = [];
  const notTraced = [];
  for (const [raw, label] of Object.entries(doc.labels ?? {})) {
    if (label?.category !== "treasury") continue;
    const address = parseHederaAddress(raw);
    if (!address) throw new Error(`${file}: treasury address ${JSON.stringify(raw)} is not a Hedera account id (0.0.N)`);
    const row = { address, name: label.name ?? "Hedera treasury" };
    if (NETWORK_IDS.has(address)) notTraced.push({ ...row, reason: NOT_TRACED_REASON });
    else if (VOLUME_EXCLUDED.has(address)) notTraced.push({ ...row, reason: VOLUME_EXCLUDED.get(address) });
    else traced.push(row);
  }
  traced.sort((a, b) => compareIds(a.address, b.address));
  notTraced.sort((a, b) => compareIds(a.address, b.address));
  return { traced, notTraced };
}

/** Registry rows (forensicsRegistry knownWallets shape) for the traced treasury accounts. */
export function hederaRegistryWallets(split, { chainKey, source }) {
  return split.traced.map((t) => ({
    address: t.address,
    label: `${t.name} ${t.address}`,
    group: "treasury",
    entityClass: "treasury",
    source,
    confidence: "high",
    chains: [chainKey],
  }));
}

/** Canonical, unique, id-ordered sender ids of a registry (config order never matters). */
export function senderIds(registry) {
  const ids = new Set();
  for (const w of registry.knownWallets ?? []) {
    const id = parseHederaAddress(w.address);
    if (!id) throw new Error(`registry wallet ${JSON.stringify(w.address)} is not a Hedera account id (0.0.N)`);
    ids.add(id);
  }
  return [...ids].sort(compareIds);
}

/**
 * Ids that must never be inside a sender stream: a range read through the mirror's account.id filter returns every
 * record touching any id in it, so a busy account would make the stream read a large share of all network
 * transactions. Consensus node accounts start at 0.0.3 and run to the last id below the treasury account 0.0.42
 * (not fetched live: the bound only has to cover the node ids, and 0.0.42 and up are treasury ids the report traces);
 * the protocol accounts are the network accounts of treasury.js; HEDERA_VOLUME_EXCLUDED are measured-busy accounts.
 */
export const NODE_ACCOUNT_FIRST = 3n;
export const NODE_ACCOUNT_LAST = 41n;
export const PROTOCOL_ACCOUNT_IDS = Object.freeze(HEDERA_NETWORK_ACCOUNTS.map((a) => `0.0.${a.num}`));
const BUSY_REASONS = new Map([
  ...PROTOCOL_ACCOUNT_IDS.map((id) => [id, "a protocol fee or reward account"]),
  ...HEDERA_VOLUME_EXCLUDED.map((a) => [a.address, "excluded for its measured request volume"]),
]);

/** Why `id` may not be a sender, or null. */
export function busyAccountReason(id) {
  const n = idNumber(id);
  if (n >= NODE_ACCOUNT_FIRST && n <= NODE_ACCOUNT_LAST) return "a consensus node account";
  return BUSY_REASONS.get(id) ?? null;
}

/** Throws when a sender id is an account every network transaction may touch. */
export function assertStreamable(ids) {
  for (const id of ids) {
    const reason = busyAccountReason(id);
    if (reason) throw new Error(`hedera wallet-flows: ${id} is ${reason}; a sender stream containing it would read a large share of all network transactions`);
  }
}

/** Contiguous runs of the sorted ids: [{ from: "0.0.44", to: "0.0.71" }, ...]. */
export function contiguousRanges(ids) {
  const sorted = [...ids].sort(compareIds);
  const ranges = [];
  for (const id of sorted) {
    const last = ranges.at(-1);
    if (last && BigInt(id.slice(4)) === BigInt(last.to.slice(4)) + 1n) last.to = id;
    else ranges.push({ from: id, to: id });
  }
  return ranges;
}

/**
 * Hash of what decides the stored scan: the sender set (it picks which records are fetched, which account owns a
 * record and how fees are matched) and the scan version. Venue lists (CEX, DEX) only label events when the
 * report is built, so they are not part of it and never cost a rescan.
 */
export const scanHash = (senders, classifierVersion) =>
  createHash("sha256").update(JSON.stringify({ scan: WALLET_SCAN_VERSION, classifier: classifierVersion, senders })).digest("hex");
