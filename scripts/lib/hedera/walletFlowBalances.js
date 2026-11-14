/**
 * Current HBAR balance of each sender account, from the mirror's /balances list read in contiguous id ranges
 * (the treasury ids are a handful of ranges, so this is a few requests, not one per account).
 * Paging follows `links.next`; a page that fails after the client's retries rejects: a partial balance table
 * is never returned.
 */
import { parseHederaAddress } from "./address.js";
import { contiguousRanges } from "./walletFlowSenders.js";
import { tinybarToHbar } from "./walletFlowsHedera.js";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_RANGE = 50;
const API_PREFIX = "/api/v1";

/** @returns {Promise<Map<string, number>>} sender id to HBAR (0 for an id the mirror lists no balance for) */
export async function fetchSenderBalances(client, ids) {
  const wanted = new Set(ids);
  const balances = new Map(ids.map((id) => [id, 0]));
  for (const { from, to } of contiguousRanges(ids)) {
    let path = `/balances?account.id=gte:${from}&account.id=lte:${to}&limit=${PAGE_SIZE}&order=asc`;
    for (let pages = 0; path; pages += 1) {
      if (pages >= MAX_PAGES_PER_RANGE) throw new Error(`hedera /balances: more than ${MAX_PAGES_PER_RANGE} pages for ${from}..${to}`);
      const body = await client.getJson(path);
      if (!body || !Array.isArray(body.balances) || !body.links || !("next" in body.links)) throw new Error(`hedera /balances: unreadable page for ${path}`);
      for (const row of body.balances) {
        const id = parseHederaAddress(row.account);
        if (!id || !wanted.has(id)) continue;
        balances.set(id, tinybarToHbar(BigInt(row.balance)));
      }
      const next = body.links.next;
      if (next !== null && typeof next !== "string") throw new Error(`hedera /balances: unreadable links.next for ${path}`);
      if (next !== null && body.balances.length === 0) throw new Error(`hedera /balances: links.next on an empty page for ${path}`);
      path = next === null ? null : next.startsWith(API_PREFIX) ? next.slice(API_PREFIX.length) : next;
    }
  }
  return balances;
}
