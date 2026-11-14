/**
 * Network-wide staked HBAR from the public mirror node (`GET /network/stake`).
 *
 * Informational only (owner decision 5, tasks/hedera-plan.md): staked HBAR stays in the holder's own
 * account, so these coins are already inside every holder balance and this figure is never subtracted
 * from anything. It carries its OWN as-of, the staking period the mirror node reports, separate from
 * the holder snapshot's settled day.
 *
 * Fields (mirror node REST API, NetworkStake): `stake_total` is the total stake on the network in
 * tinybars (1 HBAR = 1e8 tinybar); `staking_period.from` / `.to` are "seconds.nanos" consensus
 * timestamps of the period the figure describes (`to` is exclusive).
 *
 * Tinybar totals exceed 2^53 (about 1.3e18 today), so `stake_total` is read from the raw body as a
 * string and held as BigInt. The shared mirror client only protects a fixed list of field names, so
 * this one request is made directly. Never throws: any failure is an explicit unavailable result, so
 * the feed can say so instead of publishing a made-up zero.
 */
import { HEDERA_MAINNET_MIRROR } from "./mirror.js";

export const NETWORK_STAKE_PATH = "/network/stake";
export const NETWORK_STAKE_SOURCE = "mirror node /network/stake";
export const NETWORK_STAKE_DECIMALS = 8;
export const NETWORK_STAKE_ATTEMPTS = 3;
export const NETWORK_STAKE_TIMEOUT_MS = 20_000;
const BACKOFF_BASE_MS = 500;
const TINYBAR_PER_HBAR = 10n ** BigInt(NETWORK_STAKE_DECIMALS);
const STAMP = /^\d+(?:\.\d+)?$/;
const RETRYABLE = (status) => status === 429 || status >= 500;

const unavailable = (reason) => ({ available: false, reason, source: NETWORK_STAKE_SOURCE });

/** "1794528000.000000000" -> "2026-11-13T00:00:00.000Z", or null when it is not a mirror stamp. */
const stampToIso = (stamp) => {
  if (typeof stamp !== "string" || !STAMP.test(stamp)) return null;
  const ms = Number(stamp.split(".")[0]) * 1000;
  return Number.isSafeInteger(ms) ? new Date(ms).toISOString() : null;
};

/** Whole HBAR as a number without a lossy 2^53 intermediate (value error is at most one double rounding). */
const tinybarToHbar = (raw) => Number(raw / TINYBAR_PER_HBAR) + Number(raw % TINYBAR_PER_HBAR) / Number(TINYBAR_PER_HBAR);

/** Exact HBAR text, always 8 decimals: 1345671185300000000n -> "13456711853.00000000". */
export const tinybarToHbarText = (raw) =>
  `${raw / TINYBAR_PER_HBAR}.${String(raw % TINYBAR_PER_HBAR).padStart(NETWORK_STAKE_DECIMALS, "0")}`;

/** Keeps `stake_total` an exact string before JSON.parse can round it. */
export const parseNetworkStakeBody = (text) => JSON.parse(text.replace(/"stake_total"\s*:\s*(-?\d+)/, '"stake_total":"$1"'));

/** The feed value for one parsed `/network/stake` body, or an unavailable result naming what was wrong. */
export function networkStakeFromBody(body) {
  const total = body?.stake_total;
  if (typeof total !== "string" || !/^\d+$/.test(total)) return unavailable("mirror node returned no stake_total");
  const raw = BigInt(total);
  if (raw <= 0n) return unavailable("mirror node reported no staked HBAR");
  const start = stampToIso(body?.staking_period?.from);
  const end = stampToIso(body?.staking_period?.to);
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return unavailable("mirror node returned no staking period");
  return {
    available: true,
    stakedTotal: tinybarToHbar(raw),
    stakedTotalTinybar: raw.toString(),
    stakedTotalHbar: tinybarToHbarText(raw),
    decimals: NETWORK_STAKE_DECIMALS,
    stakingPeriod: { start, end },
    source: NETWORK_STAKE_SOURCE,
  };
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the network stake. chain.mirrorUrl, then HEDERA_MIRROR_URL, then the public mainnet mirror.
 * opts: { fetch, sleep, attempts, timeoutMs } (tests inject fetch and sleep).
 */
export async function fetchNetworkStake(chain, opts = {}) {
  const { fetch: fetchImpl = globalThis.fetch, sleep = sleepReal, attempts = NETWORK_STAKE_ATTEMPTS, timeoutMs = NETWORK_STAKE_TIMEOUT_MS } = opts;
  const root = (chain?.mirrorUrl ?? process.env.HEDERA_MIRROR_URL ?? HEDERA_MAINNET_MIRROR).replace(/\/+$/, "");
  let last = "no attempt made";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    try {
      const res = await fetchImpl(`${root}${NETWORK_STAKE_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        if (!RETRYABLE(res.status)) break;
        continue;
      }
      return networkStakeFromBody(parseNetworkStakeBody(await res.text()));
    } catch (error) {
      last = error?.message ?? String(error);
    }
  }
  return unavailable(`mirror node request failed (${last})`);
}
