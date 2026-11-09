/**
 * Hedera block clock. Mirror blocks are consecutive integers from 0 (2019-09-13)
 * about 2 s apart, so the integer block number stands where EVM has a block and
 * Solana a slot. Timestamps are unix seconds (fractional).
 */
const secondsOf = (stamp) => Number(stamp);

/**
 * First n in [lo, hi] with getTime(n) >= target, or null. Blocks are dense and
 * time is monotonic, so a plain binary search is exact. A getTime failure
 * propagates: a guess is never returned.
 */
export async function firstBlockAtOrAfter(targetSeconds, getTime, lo, hi) {
  let a = lo;
  let b = hi;
  let best = null;
  while (a <= b) {
    const mid = Math.floor((a + b) / 2);
    if ((await getTime(mid)) >= targetSeconds) {
      best = mid;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  return best;
}

export function createHederaClock(client) {
  const block = (b) => ({ number: b.number, timestamp: secondsOf(b.timestamp.from) });
  async function latest() {
    const { blocks } = await client.getJson("/blocks?limit=1&order=desc");
    if (!blocks?.length) throw new Error("hedera /blocks returned no block");
    return block(blocks[0]);
  }
  async function timeOf(n) {
    return block(await client.getJson(`/blocks/${n}`)).timestamp;
  }
  /** (targetSeconds[, getTime, lo, hi]) -> first block number at or after, null when none. */
  async function firstAtOrAfter(targetSeconds, getTime = timeOf, lo = 0, hi = undefined) {
    const high = hi ?? (await latest()).number;
    return firstBlockAtOrAfter(targetSeconds, getTime, lo, high);
  }
  /** Highest block whose timestamp is at or before `stamp` (a mirror "seconds.nanos" string). */
  async function blockAtOrBefore(stamp) {
    const { blocks } = await client.getJson(`/blocks?limit=1&order=desc&timestamp=lte:${stamp}`);
    return blocks?.length ? block(blocks[0]) : null;
  }
  return { latest, timeOf, firstAtOrAfter, blockAtOrBefore };
}
