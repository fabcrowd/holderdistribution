/**
 * treasuryCexBackfill.js
 *
 * Pure logic for scripts/backfill-treasury-cex-history.js: reconstruct missing
 * dated rows of treasury-history.json and cex-balance-history.json. No file or
 * network access here; every RPC call goes through the injected `client`.
 *
 * METHOD (anchored delta replay)
 * A missing row is built from the closest EXISTING row before it (the anchor,
 * which is itself the pipeline's own supply-reconciliation output) plus the net
 * Transfer flow of the watched addresses between the anchor's day-boundary
 * block and the target's day-boundary block, in TEL units across every chain
 * and every token generation (legacy + v3 sum 1:1). Transfers between two
 * watched addresses cancel, so category totals need no per-address anchor.
 *
 * The same replay is carried on to the first existing row AFTER the range and
 * compared with it: that drift is the only built-in proof the reconstruction is
 * right, and the CLI refuses to write when it is too large.
 *
 * KNOWN LIMITS
 *  - Day boundary = last block at or before 23:59:59 UTC (the convention of
 *    holders-asof-blocks.json / pull-holders-rpc --as-of). Live rows are taken
 *    mid-morning, so a reconstructed row can differ from a live one by the
 *    flows of part of a day.
 *  - Legacy TEL credited to an upgrade contract (TokenMigration) is "retired"
 *    by reconcile-supply (netted against minted v3), so those credits are
 *    ignored here; a stranded plain transfer to it would be missed (it is
 *    ~0.2M TEL, far below the drift tolerance).
 */
import { rawToTel } from "./telTokens.js";
import { partitionLogsByBoundary } from "./historicalReplay.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const round2 = (n) => Math.round(n * 100) / 100;

/** Every ISO date from `from` to `to` inclusive. Throws on a bad or inverted range. */
export function enumerateDates(from, to) {
  if (!ISO_DATE.test(from ?? "") || !ISO_DATE.test(to ?? "")) throw new Error("--from and --to must be YYYY-MM-DD");
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("--from and --to must be real dates");
  if (start > end) throw new Error(`--from ${from} is after --to ${to}`);
  const out = [];
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Dates in `dates` that have no entry in `entries`. */
export function missingDates(entries, dates) {
  const present = new Set((entries ?? []).map((e) => e.date));
  return dates.filter((d) => !present.has(d));
}

/** Latest entry strictly before `date`, or null. `entries` need not be sorted. */
export function priorEntry(entries, date) {
  let best = null;
  for (const e of entries ?? []) if (e.date < date && (!best || e.date > best.date)) best = e;
  return best;
}

/** Earliest entry strictly after `date`, or null. */
export function nextEntry(entries, date) {
  let best = null;
  for (const e of entries ?? []) if (e.date > date && (!best || e.date < best.date)) best = e;
  return best;
}

const ANCHOR_TOLERANCE = 0.1;
const ANCHOR_HISTORY_WINDOW = 5;

const median = (values) => {
  const v = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * Closest earlier row of `entries` that can be trusted as a replay anchor.
 * A row is rejected when some category deviates by more than `tolerance`
 * (fraction) from BOTH references: the first real row after `date`, and the
 * per-category median of the `ANCHOR_HISTORY_WINDOW` rows before it. A genuine step
 * change matches the later row; a snapshot taken without a known wallet (e.g.
 * a missing Safe) matches neither, even when several such snapshots are
 * adjacent. Rejected rows are walked past, so the anchor falls back to an
 * older row.
 *
 * @returns {{anchor: ?object, rejected: string[]}}
 */
export function trustedAnchor(entries, date, categories, tolerance = ANCHOR_TOLERANCE) {
  const sorted = (entries ?? []).filter((e) => e.date < date).sort((a, b) => b.date.localeCompare(a.date));
  const next = nextEntry(entries, date);
  const rejected = [];
  const deviates = (row, reference) =>
    categories.some((key) => {
      const a = Number(row.categories?.[key]);
      const b = reference(key);
      return Number.isFinite(a) && Number.isFinite(b) && relativeDrift(a, b) > tolerance;
    });
  for (let i = 0; i < sorted.length; i++) {
    const older = sorted.slice(i + 1, i + 1 + ANCHOR_HISTORY_WINDOW);
    const references = [];
    if (next) references.push((key) => Number(next.categories?.[key]));
    if (older.length) references.push((key) => median(older.map((e) => Number(e.categories?.[key]))));
    if (references.length && references.every((ref) => deviates(sorted[i], ref))) {
      rejected.push(sorted[i].date);
      continue;
    }
    return { anchor: sorted[i], rejected };
  }
  return { anchor: null, rejected };
}

/**
 * Label eras: rows written before `before` used older category labels (e.g.
 * TELx reward contracts were "council" until relabelled to "staking"). Returns
 * the address -> category map in force for `date` and an `era` key so callers
 * can refuse to mix eras inside one replay.
 *
 * @param {Map<string,string>} base current labels
 * @param {Array<{before:string, categories:Record<string,string>}>} eras
 */
export function categoryMapForDate(base, eras, date) {
  const era = [...(eras ?? [])].sort((a, b) => a.before.localeCompare(b.before)).find((e) => date < e.before);
  if (!era) return { era: "current", map: base };
  const map = new Map(base);
  for (const [address, category] of Object.entries(era.categories ?? {})) map.set(lower(address), category);
  return { era: `before ${era.before}`, map };
}

/**
 * address -> category from the project's exclusion labels, restricted to the
 * treasury categories (same source reconcile-supply buckets by).
 */
export function categoryAddressMap(exclusions, categories) {
  const wanted = new Set(categories);
  const map = new Map();
  for (const [address, meta] of Object.entries(exclusions?.labels ?? {})) {
    const a = lower(address);
    if (EVM_ADDRESS.test(a) && wanted.has(meta?.category)) map.set(a, meta.category);
  }
  return map;
}

/** address -> exchange label from the curated CEX wallet list (EVM addresses only). */
export function exchangeAddressMap(cexWallets) {
  const map = new Map();
  for (const w of cexWallets?.wallets ?? []) {
    const a = lower(w?.address);
    const label = typeof w?.label === "string" && w.label.trim() ? w.label.trim() : "Unknown";
    if (EVM_ADDRESS.test(a)) map.set(a, label);
  }
  return map;
}

/**
 * Running net raw balance change of the `watched` addresses at each boundary
 * (cumulative from the first transfer passed in).
 *
 * `ignoreCreditTo`: addresses whose INCOMING transfers of this token are
 * skipped (retired legacy TEL held by the upgrade contracts).
 *
 * @param {{transfers: Array<{from:?string,to:?string,value:bigint,blockNumber:string|number}>,
 *          boundaries: Array<{date:string, block:number}>, watched:Set<string>,
 *          ignoreCreditTo?:?Set<string>}} args
 * @returns {Map<string, Map<string, bigint>>} date -> address -> raw net
 */
export function cumulativeNetByBoundary({ transfers, boundaries, watched, ignoreCreditTo = null }) {
  const running = new Map();
  const bump = (address, delta) => running.set(address, (running.get(address) ?? 0n) + delta);
  const out = new Map();
  for (const { logs, boundary } of partitionLogsByBoundary(transfers, boundaries)) {
    for (const t of logs) {
      const to = lower(t.to);
      const from = lower(t.from);
      const value = BigInt(t.value);
      if (to && watched.has(to) && !ignoreCreditTo?.has(to)) bump(to, value);
      if (from && watched.has(from)) bump(from, -value);
    }
    if (boundary) out.set(boundary.date, new Map(running));
  }
  return out;
}

/** Raw bigint map -> TEL-unit number map. */
export const toTokenUnits = (rawMap, decimals) =>
  new Map([...rawMap].map(([address, raw]) => [address, rawToTel(raw, decimals)]));

/** Sums several date -> address -> number maps (one per chain/token) into one. */
export function mergeCumulative(parts) {
  const merged = new Map();
  for (const part of parts) {
    for (const [date, byAddress] of part) {
      const target = merged.get(date) ?? new Map();
      for (const [address, value] of byAddress) target.set(address, (target.get(address) ?? 0) + value);
      merged.set(date, target);
    }
  }
  return merged;
}

/** Net change per group between two dates, where `groupOf(address)` names the group (or undefined to skip). */
export function groupDelta(cum, fromDate, toDate, groupOf) {
  const before = cum.get(fromDate) ?? new Map();
  const after = cum.get(toDate) ?? new Map();
  const out = new Map();
  for (const address of new Set([...before.keys(), ...after.keys()])) {
    const group = groupOf(address);
    if (group === undefined) continue;
    out.set(group, (out.get(group) ?? 0) + ((after.get(address) ?? 0) - (before.get(address) ?? 0)));
  }
  return out;
}

/** Treasury row = anchor categories + net flow. Whole TEL, like append-treasury-history. */
export function buildTreasuryEntry({ date, anchor, delta, categories }) {
  const out = {};
  for (const key of categories) {
    const base = Number(anchor.categories?.[key]);
    if (!Number.isFinite(base)) throw new Error(`anchor ${anchor.date} has no finite "${key}"`);
    const value = Math.round(base + (delta.get(key) ?? 0));
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${date} ${key}: reconstructed ${value} is not a valid balance (anchor ${anchor.date} = ${base})`);
    }
    out[key] = value;
  }
  return { date, categories: out, backfilled: true };
}

/** CEX row = anchor exchanges + net flow. Positive balances only, 2 dp, like pull-cex-wallets. */
export function buildCexEntry({ date, anchor, delta }) {
  const names = [...new Set([...Object.keys(anchor.exchanges ?? {}), ...delta.keys()])];
  const exchanges = {};
  for (const name of names) {
    const value = round2((Number(anchor.exchanges?.[name]) || 0) + (delta.get(name) ?? 0));
    if (value < -0.01) throw new Error(`${date} ${name}: reconstructed negative balance ${value}`);
    if (value > 0) exchanges[name] = value;
  }
  const total = round2(Object.values(exchanges).reduce((s, v) => s + v, 0));
  return { date, exchanges, total, backfilled: true };
}

/** Relative drift (fraction) of `computed` vs `actual`, scaled by the larger magnitude. */
export const relativeDrift = (computed, actual, floor = 1) =>
  Math.abs(computed - actual) / Math.max(Math.abs(computed), Math.abs(actual), floor);

/**
 * Appends `rows` to `entries` without ever replacing an existing date.
 * @returns {{entries: object[], added: string[], skipped: string[]}}
 */
export function mergeBackfilledEntries(entries, rows) {
  const have = new Set((entries ?? []).map((e) => e.date));
  const added = [];
  const skipped = [];
  const merged = [...(entries ?? [])];
  for (const row of rows) {
    if (have.has(row.date)) {
      skipped.push(row.date);
      continue;
    }
    have.add(row.date);
    added.push(row.date);
    merged.push(row);
  }
  merged.sort((a, b) => a.date.localeCompare(b.date));
  return { entries: merged, added, skipped };
}

const sortedUnique = (list) => [...new Set(list)].sort();

/**
 * Reconstructs every missing treasury / cex row in [from, to].
 *
 * @param {object} args
 * @param {{entries: object[]}} args.treasuryHistory
 * @param {{entries: object[]}} args.cexHistory
 * @param {string} args.from
 * @param {string} args.to
 * @param {string[]} args.categories treasury category keys (chart lines)
 * @param {Map<string,string>} args.categoryByAddress
 * @param {Array<{before:string, categories:Record<string,string>}>} [args.categoryEras] older labels for rows before a date
 * @param {number} [args.anchorTolerance] max category deviation (fraction) before a treasury anchor is rejected
 * @param {Map<string,string>} args.exchangeByAddress
 * @param {Array<{key:string, tokens:Array<{address:string, decimals:number, generation:string, deployBlock?:?number}>, upgradeContracts?:string[]}>} args.chains
 * @param {Record<string, Record<string, number>>} [args.blockCache] date -> chain -> boundary block
 * @param {{blockAtEndOfDate:(chainKey:string,date:string)=>Promise<number>,
 *          fetchTransfers:(a:{chainKey:string,tokenAddress:string,fromBlock:number,toBlock:number})=>Promise<Array>}} args.client
 * @param {(msg:string)=>void} [args.log]
 */
export async function reconstructHistory({
  treasuryHistory,
  cexHistory,
  from,
  to,
  categories,
  categoryByAddress,
  categoryEras = [],
  anchorTolerance = ANCHOR_TOLERANCE,
  exchangeByAddress,
  chains,
  blockCache = {},
  client,
  log = () => {},
}) {
  const dates = enumerateDates(from, to);
  const skipped = [];
  const targets = { treasury: [], cex: [] };
  const anchors = new Map(); // `${kind}:${date}` -> anchor entry
  for (const [kind, history] of [["treasury", treasuryHistory], ["cex", cexHistory]]) {
    for (const date of missingDates(history.entries, dates)) {
      let anchor;
      if (kind === "treasury") {
        const picked = trustedAnchor(history.entries, date, categories, anchorTolerance);
        if (picked.rejected.length) log(`  treasury ${date}: skipped untrusted anchor row(s) ${picked.rejected.join(", ")}`);
        anchor = picked.anchor;
      } else {
        anchor = priorEntry(history.entries, date);
      }
      if (!anchor) {
        skipped.push({ kind, date, reason: "no trustworthy earlier existing row to anchor on" });
        continue;
      }
      anchors.set(`${kind}:${date}`, anchor);
      targets[kind].push(date);
    }
  }
  const result = { treasuryRows: [], cexRows: [], drift: { treasury: null, cex: null }, resolvedBlocks: {}, skipped };
  if (!targets.treasury.length && !targets.cex.length) return result;

  // The first EXISTING row after the range validates the replay.
  const lastTarget = [...targets.treasury, ...targets.cex].sort().at(-1);
  const validation = {
    treasury: nextEntry(treasuryHistory.entries, lastTarget),
    cex: nextEntry(cexHistory.entries, lastTarget),
  };
  const needed = sortedUnique([
    ...targets.treasury,
    ...targets.cex,
    ...[...anchors.values()].map((a) => a.date),
    ...Object.values(validation).filter(Boolean).map((e) => e.date),
  ]);

  const blocks = {};
  for (const date of needed) {
    blocks[date] = {};
    for (const chain of chains) {
      const cached = blockCache[date]?.[chain.key];
      if (Number.isFinite(Number(cached))) {
        blocks[date][chain.key] = Number(cached);
        continue;
      }
      const block = await client.blockAtEndOfDate(chain.key, date);
      if (!Number.isFinite(block)) throw new Error(`no boundary block for ${chain.key} ${date}`);
      blocks[date][chain.key] = block;
      (result.resolvedBlocks[date] ??= {})[chain.key] = block;
    }
  }

  const watched = new Set([
    ...categoryByAddress.keys(),
    ...exchangeByAddress.keys(),
    ...categoryEras.flatMap((e) => Object.keys(e.categories ?? {}).map(lower)),
  ]);
  const parts = [];
  for (const chain of chains) {
    const boundaries = needed.map((date) => ({ date, block: blocks[date][chain.key] }));
    for (let i = 1; i < boundaries.length; i++) {
      if (boundaries[i].block < boundaries[i - 1].block) {
        throw new Error(`${chain.key}: boundary blocks not ascending at ${boundaries[i].date}`);
      }
    }
    const startBlock = boundaries[0].block;
    const endBlock = boundaries.at(-1).block;
    for (const token of chain.tokens) {
      if (token.deployBlock && endBlock < token.deployBlock) continue;
      const fromBlock = Math.max(startBlock + 1, token.deployBlock ?? 0);
      log(`  ${chain.key} ${token.generation}: transfers ${fromBlock}..${endBlock}`);
      const transfers = await client.fetchTransfers({
        chainKey: chain.key,
        tokenAddress: token.address,
        fromBlock,
        toBlock: endBlock,
      });
      const ignoreCreditTo =
        token.generation === "legacy" && chain.upgradeContracts?.length ? new Set(chain.upgradeContracts.map(lower)) : null;
      const cumRaw = cumulativeNetByBoundary({ transfers, boundaries, watched, ignoreCreditTo });
      parts.push(new Map([...cumRaw].map(([date, m]) => [date, toTokenUnits(m, token.decimals)])));
    }
  }
  const cum = mergeCumulative(parts);

  const exchangeOf = (a) => exchangeByAddress.get(a);
  const treasuryAt = (anchor, date) => {
    const at = categoryMapForDate(categoryByAddress, categoryEras, date);
    const anchorEra = categoryMapForDate(categoryByAddress, categoryEras, anchor.date).era;
    if (at.era !== anchorEra) {
      throw new Error(`treasury ${date} (labels ${at.era}) cannot be replayed from ${anchor.date} (labels ${anchorEra}): narrow --from/--to to one label era`);
    }
    return buildTreasuryEntry({ date, anchor, delta: groupDelta(cum, anchor.date, date, (a) => at.map.get(a)), categories });
  };
  const cexAt = (anchor, date) => buildCexEntry({ date, anchor, delta: groupDelta(cum, anchor.date, date, exchangeOf) });

  for (const date of targets.treasury) result.treasuryRows.push(treasuryAt(anchors.get(`treasury:${date}`), date));
  for (const date of targets.cex) result.cexRows.push(cexAt(anchors.get(`cex:${date}`), date));

  // Replay the same machinery onto the next real row; its difference is the error bar.
  if (validation.treasury && targets.treasury.length) {
    const anchor = anchors.get(`treasury:${targets.treasury.at(-1)}`);
    const replayed = treasuryAt(anchor, validation.treasury.date);
    result.drift.treasury = {
      date: validation.treasury.date,
      byCategory: Object.fromEntries(
        categories.map((key) => [
          key,
          { computed: replayed.categories[key], actual: validation.treasury.categories?.[key], drift: relativeDrift(replayed.categories[key], Number(validation.treasury.categories?.[key])) },
        ]),
      ),
    };
  }
  if (validation.cex && targets.cex.length) {
    const anchor = anchors.get(`cex:${targets.cex.at(-1)}`);
    const replayed = cexAt(anchor, validation.cex.date);
    const names = [...new Set([...Object.keys(replayed.exchanges), ...Object.keys(validation.cex.exchanges ?? {})])];
    result.drift.cex = {
      date: validation.cex.date,
      total: { computed: replayed.total, actual: validation.cex.total, drift: relativeDrift(replayed.total, Number(validation.cex.total)) },
      byExchange: Object.fromEntries(
        names.map((n) => {
          const computed = replayed.exchanges[n] ?? 0;
          const actual = Number(validation.cex.exchanges?.[n]) || 0;
          return [n, { computed, actual, drift: relativeDrift(computed, actual, validation.cex.total * 0.001) }];
        }),
      ),
    };
  }
  return result;
}

/** Worst drift fraction in a reconstructHistory() result (categories and cex total). */
export function worstDrift(drift) {
  const values = [
    ...Object.values(drift?.treasury?.byCategory ?? {}).map((c) => c.drift),
    ...(drift?.cex ? [drift.cex.total.drift] : []),
  ];
  return values.length ? Math.max(...values) : 0;
}
