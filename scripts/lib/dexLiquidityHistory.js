/**
 * Pure helpers for reconstructing historical DEX TEL liquidity from tokentx.
 *
 * Matches generate-holders-history.js sumDexLiquidity address set:
 * exclusions.labels category:"dex" ∪ dex-contracts pools ∪ routers.
 */

/**
 * @param {{ labels?: Record<string, { category?: string }> }|null|undefined} exclusions
 * @param {{ pools?: Array<{ address?: string }>, routers?: Array<{ address?: string }> }|null|undefined} dexConfig
 * @returns {Set<string>}
 */
export const collectDexAddresses = (exclusions, dexConfig) => {
  const set = new Set();
  for (const [addr, meta] of Object.entries(exclusions?.labels ?? {})) {
    if (meta?.category !== "dex") continue;
    const a = typeof addr === "string" ? addr.trim().toLowerCase() : "";
    if (a) set.add(a);
  }
  for (const p of dexConfig?.pools ?? []) {
    const a = typeof p?.address === "string" ? p.address.trim().toLowerCase() : "";
    if (a) set.add(a);
  }
  for (const r of dexConfig?.routers ?? []) {
    const a = typeof r?.address === "string" ? r.address.trim().toLowerCase() : "";
    if (a) set.add(a);
  }
  return set;
};

/**
 * @param {string|null|undefined} v
 * @returns {string|null}
 */
export const normalizeAddress = (v) => {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(t) ? t : null;
};

/**
 * Build signed raw-unit deltas for one address from tokentx rows.
 * +value when address receives TEL; −value when it sends. Self-transfers are 0.
 *
 * @param {Array<{ from?: string, to?: string, value?: string, timeStamp?: string|number, hash?: string, logIndex?: string|number }>} transfers
 * @param {string} address normalized lowercase
 * @returns {Array<{ ts: number, delta: bigint, key: string }>}
 */
export const buildTransferDeltas = (transfers, address) => {
  const self = normalizeAddress(address);
  if (!self) return [];
  const events = [];
  const seen = new Set();

  for (const tx of transfers ?? []) {
    const from = normalizeAddress(tx.from);
    const to = normalizeAddress(tx.to);
    const ts = Number(tx.timeStamp) * 1000;
    if (!Number.isFinite(ts)) continue;

    const logIndex = tx.logIndex != null && tx.logIndex !== "" ? String(tx.logIndex) : "";
    const key = `${tx.hash ?? ""}:${logIndex}:${from ?? ""}:${to ?? ""}:${tx.value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let delta = 0n;
    try {
      const value = BigInt(tx.value ?? "0");
      if (to === self && from !== self) delta += value;
      if (from === self && to !== self) delta -= value;
    } catch {
      continue;
    }
    if (delta === 0n) continue;
    events.push({ ts, delta, key });
  }

  return events.sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : 1));
};

/**
 * Balance (raw units) at end-of-day by walking transfers after that instant
 * backwards from a known current balance.
 *
 * @param {Array<{ ts: number, delta: bigint }>} timeline ascending
 * @param {number} endOfDayTs inclusive end of the sample day (ms)
 * @param {bigint} currentBalanceRaw balance at/after the latest transfer (and now)
 * @returns {bigint}
 */
export const balanceAsOfWorkingBackwards = (timeline, endOfDayTs, currentBalanceRaw) => {
  let bal = currentBalanceRaw;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const ev = timeline[i];
    if (ev.ts <= endOfDayTs) break;
    bal -= ev.delta;
  }
  if (bal < 0n) bal = 0n;
  return bal;
};

/**
 * @param {bigint} raw
 * @param {number} decimals
 * @returns {number}
 */
export const rawToTel = (raw, decimals = 2) => {
  const div = 10n ** BigInt(decimals);
  // Keep integer TEL for history (matches Math.round in generate-holders-history).
  const whole = raw / div;
  const frac = raw % div;
  // Round half-up using fractional digits.
  if (frac * 2n >= div) return Number(whole + 1n);
  return Number(whole);
};

/**
 * Sum per-chain raw balances for one sample timestamp across many address timelines.
 *
 * @param {Array<{ timeline: Array<{ ts: number, delta: bigint }>, currentRaw: bigint }>} legs
 * @param {number} endOfDayTs
 * @param {number} [decimals=2]
 * @returns {number} rounded TEL
 */
export const sumDexLiquidityAt = (legs, endOfDayTs, decimals = 2) => {
  let totalRaw = 0n;
  for (const leg of legs ?? []) {
    totalRaw += balanceAsOfWorkingBackwards(leg.timeline, endOfDayTs, leg.currentRaw);
  }
  return rawToTel(totalRaw, decimals);
};
