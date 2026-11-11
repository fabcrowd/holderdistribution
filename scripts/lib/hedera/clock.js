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
  /**
   * Block numbers are only a clock if they are consecutive and time-ordered; the binary search assumes it.
   * Checks the answer's neighbours: n-1 must exist and be earlier, n+1 (absent at the head) must be later.
   */
  async function assertDenseAround(b) {
    const fail = (why) => new Error(`hedera blocks are not dense around block ${b.number}: ${why}`);
    if (b.number > 0) {
      let before;
      try {
        before = await timeOf(b.number - 1);
      } catch (e) {
        throw fail(`block ${b.number - 1} is unreadable (${e.message})`);
      }
      if (!(before < b.timestamp)) throw fail(`block ${b.number - 1} is not earlier (${before} >= ${b.timestamp})`);
    }
    let after = null;
    try {
      after = await timeOf(b.number + 1);
    } catch (e) {
      if (!/HTTP 404/.test(e.message)) throw e;
    }
    if (after !== null && !(after > b.timestamp)) throw fail(`block ${b.number + 1} is not later (${after} <= ${b.timestamp})`);
  }
  /** Highest block whose timestamp is at or before `stamp` (a mirror "seconds.nanos" string), after the density check. */
  async function blockAtOrBefore(stamp) {
    const { blocks } = await client.getJson(`/blocks?limit=1&order=desc&timestamp=lte:${stamp}`);
    if (!blocks?.length) return null;
    const found = block(blocks[0]);
    await assertDenseAround(found);
    return found;
  }
  return { latest, timeOf, firstAtOrAfter, blockAtOrBefore };
}
