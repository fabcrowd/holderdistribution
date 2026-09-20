/**
 * historicalReplay.js
 *
 * Pure helpers for reconstructing per-date token balances by replaying Transfer
 * logs in block order.
 *
 * WHY THIS EXISTS
 *
 * `holders-history.json` was previously only correctable by re-deriving past
 * dates from committed `tel-holders.json` snapshots, which caps accuracy at
 * whatever the original scan happened to record. That made the 2026-02-28
 * MIN_TEL_RAW change (threshold 101 -> 1 raw units) look permanently
 * unfixable: wallets under ~1.01 TEL were never written to any snapshot, so
 * there was nothing to recover them from, and the changelog recorded it as
 * `backfillStatus: "not-possible"`.
 *
 * That reasoning was too narrow. It assumed recovering those balances needed
 * archived *state* (`eth_call` at a historical block), which public nodes gate
 * behind a paid archive tier. It does not. A token balance is fully determined
 * by the Transfer logs preceding it, and logs are ordinary historical data. So
 * replaying every Transfer from the token's genesis block, in order, yields the
 * exact balance map at any past block — including wallets no scan ever saw.
 *
 * The replay is a single pass. `streamTransferLogs()` in pull-holders-rpc.js
 * already fetches chunks concurrently but *applies* them in ascending block
 * order, so crossing a date's block height during that pass is the natural
 * moment to snapshot. One scan per chain therefore produces every date, rather
 * than one scan per date.
 *
 * ORDERING MATTERS HERE, UNLIKE IN THE DAILY PIPELINE
 *
 * buildBalanceMap()'s comment notes that balance accounting is commutative, so
 * out-of-order batches are safe. That holds for a FINAL balance and not for an
 * intermediate one: a snapshot taken at block N must include every transfer at
 * or below N and none above it. Hence `partitionLogsByBoundary` below, which
 * splits a batch at date boundaries before any of it is applied.
 */

/** A log's block height as a number, or null when malformed. */
const blockNumberOf = (log) => {
  const raw = log?.blockNumber;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 16);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Splits `logs` into runs separated by the given block boundaries.
 *
 * `boundaries` is an ascending list of `{ date, block }`. A boundary at block B
 * means "snapshot after every log at height <= B has been applied".
 *
 * Returns `[{ logs, boundary }]` in order. `boundary` is the boundary to
 * snapshot at once that run is applied, or null for the trailing run that
 * reaches no boundary. A boundary with no logs before it still yields an entry
 * (with an empty `logs` array) so a date in a quiet stretch is never skipped.
 *
 * Logs are sorted by block height defensively — `eth_getLogs` returns them in
 * order, but a snapshot silently taken at the wrong point would be very hard to
 * detect downstream.
 */
export const partitionLogsByBoundary = (logs, boundaries) => {
  const sorted = [...(logs ?? [])]
    .map((log) => ({ log, block: blockNumberOf(log) }))
    .filter((entry) => entry.block !== null)
    .sort((a, b) => a.block - b.block);

  const runs = [];
  let index = 0;

  for (const boundary of boundaries ?? []) {
    const run = [];
    while (index < sorted.length && sorted[index].block <= boundary.block) {
      run.push(sorted[index].log);
      index += 1;
    }
    runs.push({ logs: run, boundary });
  }

  if (index < sorted.length) {
    runs.push({ logs: sorted.slice(index).map((entry) => entry.log), boundary: null });
  }

  return runs;
};

/**
 * Finds the highest block whose timestamp is <= `targetSeconds`, by binary
 * search over block headers.
 *
 * `getTimestamp(block)` returns that block's unix timestamp. Header reads are
 * not archive-gated, so this works on ordinary RPC endpoints. Injected rather
 * than called directly so the search is testable without a node.
 *
 * Returns null when the whole range postdates the target (i.e. the chain had
 * not yet reached that time).
 */
export const findBlockAtTime = async (targetSeconds, { low, high, getTimestamp }) => {
  if (!(await getTimestamp(low) <= targetSeconds)) return null;

  let lo = low;
  let hi = high;
  while (lo < hi) {
    // Bias upward so `lo` converges on the last block at or below the target
    // rather than looping forever when hi === lo + 1.
    const mid = Math.ceil((lo + hi) / 2);
    const ts = await getTimestamp(mid);
    if (ts <= targetSeconds) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** UTC midnight, in unix seconds, for each date from `startDate` to `endDate`. */
export const dailyBoundaries = (startDate, endDate) => {
  const out = [];
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (let t = Date.parse(`${startDate}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push({ date: new Date(t).toISOString().slice(0, 10), seconds: Math.floor(t / 1000) });
  }
  return out;
};

/**
 * Splits [from, to] into `n` contiguous, non-overlapping block ranges — one
 * per available RPC key, so a cursor-paginated endpoint like
 * alchemy_getAssetTransfers (whose pagination is sequential WITHIN one query)
 * can still run in parallel across keys. The caller re-sorts the merged
 * results afterward (see partitionLogsByBoundary above), so shard completion
 * order doesn't matter — only that every block in [from, to] is covered by
 * exactly one shard.
 */
export const shardRange = (from, to, n) => {
  if (n < 1) throw new Error("shardRange: n must be >= 1");
  const span = to - from + 1;
  const size = Math.ceil(span / n);
  const shards = [];
  for (let start = from; start <= to; start += size) {
    shards.push({ fromBlock: start, toBlock: Math.min(start + size - 1, to) });
  }
  return shards;
};

/**
 * Running balance map with non-destructive snapshots.
 *
 * buildBalanceMap() in pull-holders-rpc.js can't be reused here: its
 * `finalize()` clears the underlying map (it is called once, at the end), and
 * `getRawState()` drops anything below the dust threshold. A historical replay
 * needs to read the map repeatedly and keep accumulating afterwards.
 *
 * `minRaw` matches pull-holders-rpc.js's MIN_TEL_RAW so the rebuilt history
 * uses the same dust floor as the live pipeline — that floor being uniform
 * across the series is the whole point of the rebuild.
 */
export const createReplayLedger = ({ decimals = 2, minRaw = 1n } = {}) => {
  const raw = new Map();
  const scale = 10 ** decimals;

  return {
    apply(parsedTransfers) {
      for (const { from, to, value } of parsedTransfers) {
        if (to) raw.set(to, (raw.get(to) ?? 0n) + value);
        if (from) raw.set(from, (raw.get(from) ?? 0n) - value);
      }
    },
    /** Human-scaled balances above the dust floor. Leaves the ledger intact. */
    snapshot() {
      const out = new Map();
      for (const [address, balance] of raw) {
        if (balance < minRaw) continue;
        out.set(address, Number(balance) / scale);
      }
      return out;
    },
    /** Serialisable state for the resume checkpoint. */
    serialize() {
      const out = {};
      for (const [address, balance] of raw) {
        if (balance >= minRaw) out[address] = balance.toString();
      }
      return out;
    },
    restore(state) {
      raw.clear();
      for (const [address, value] of Object.entries(state ?? {})) raw.set(address, BigInt(value));
    },
    get size() {
      return raw.size;
    },
  };
};

/**
 * Absolute stake per account at a point in time, from replayed
 * `StakeChanged(address indexed account, uint256 oldStake, uint256 newStake)`
 * logs. `newStake` is absolute, so the latest event per account wins and no
 * running arithmetic is needed — which is why historical staking needs no
 * archived `stakedBy()` reads.
 */
export const createStakeLedger = ({ decimals = 2 } = {}) => {
  const stakes = new Map();
  const scale = 10 ** decimals;

  return {
    apply(events) {
      for (const { account, newStake } of events) {
        if (account) stakes.set(account, newStake);
      }
    },
    snapshot() {
      const out = new Map();
      for (const [account, stake] of stakes) {
        if (stake > 0n) out.set(account, Number(stake) / scale);
      }
      return out;
    },
    serialize() {
      const out = {};
      for (const [account, stake] of stakes) out[account] = stake.toString();
      return out;
    },
    restore(state) {
      stakes.clear();
      for (const [account, value] of Object.entries(state ?? {})) stakes.set(account, BigInt(value));
    },
    get size() {
      return stakes.size;
    },
  };
};
