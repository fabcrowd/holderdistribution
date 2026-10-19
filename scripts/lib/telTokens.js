/**
 * Dual-token (legacy TEL + TEL v3) balance accounting.
 *
 * WHY THIS EXISTS
 * Telcoin replaced TEL with an upgraded token ("TEL v3"): 18 decimals instead of
 * 2, one address on Ethereum/Polygon/Base. Holders swap 1:1 through the
 * `TokenMigration` contract, which TAKES the caller's legacy TEL (locking it
 * forever) and MINTS the same amount of v3 to the caller. So, during the
 * upgrade, the same TEL exists twice on the ledger: once as legacy TEL sitting
 * in the upgrade contract, once as v3 in the swapper's wallet.
 *
 * A wallet's TEL balance is therefore `legacy + v3`, both normalised to TEL
 * units with each token's OWN decimals (never a hardcoded 2), and the legacy TEL
 * that the upgrade contracts hold in exchange for minted v3 must be netted out
 * ("retired") or every swapped token is counted twice. That is exactly the
 * ~3.08B overshoot (parts 103.08B against a 100B total) the legacy-only
 * pipeline produced once swaps began.
 *
 * On-chain facts this module is built around (verified 2026-10-18, see
 * docs/TEL-CONTRACTS.md "Supply accounting"):
 *   - Σ v3 totalSupply over the three chains == Σ legacy TEL held by
 *     TokenMigration, to the cent, EXCEPT for legacy TEL sent to the contract
 *     WITHOUT a swap (224,744.38 TEL on Polygon, a plain transfer with no v3
 *     mint). Those tokens are stranded, not swapped, so they stay counted on the
 *     contract's own wallet — once.
 *   - v3 crosses chains by burn-and-mint (LayerZero OFT), so bridged v3 never
 *     sits in a lock contract and nets to zero across chains.
 *
 * "Retired" legacy TEL is determined from the logs, not assumed: a legacy
 * Transfer INTO an upgrade contract counts as swapped only when the SAME
 * transaction also issues v3 (a mint from the zero address, or a release from an
 * upgrade contract's own reserve), capped at the amount of v3 issued in that
 * transaction.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** 10n ** n, for n >= 0. */
const pow10 = (n) => 10n ** BigInt(n);

/**
 * Exact BigInt raw amount -> TEL (Number). Splits whole/fraction so a 1e29-raw
 * v3 balance does not lose its low digits to a single huge float division.
 */
export function rawToTel(raw, decimals) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const d = BigInt(decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** d;
  const frac = abs % 10n ** d;
  const tel = Number(whole) + Number(frac) / Number(10n ** d);
  return negative ? -tel : tel;
}

/** TEL values are published at 6 dp: legacy is 2 dp already, v3 has 18. */
export const roundTel = (value) => Math.round(value * 1e6) / 1e6;

const isAddress = (v) => /^0x[a-f0-9]{40}$/.test(norm(v));
const toDecimals = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    throw new Error(`Invalid decimals for ${label}: ${JSON.stringify(v)}`);
  }
  return n;
};

/**
 * Resolve the token set for a chain from config/chains.json.
 *
 * Backward compatible: a chain without `tokens` (or whose `tokens.v3` has no
 * address) is legacy-only, exactly as before. Decimals always come from config;
 * the historical default of 2 applies ONLY to a legacy token that omits it.
 *
 * @returns {{ legacy: {address:string, decimals:number},
 *             v3: null | {address:string, decimals:number, deployBlock:number|null},
 *             escrow: string[] }}
 */
export function resolveChainTokens(chainMeta) {
  const legacyAddr = norm(chainMeta?.tokens?.legacy?.address ?? chainMeta?.tokenAddress);
  if (!isAddress(legacyAddr)) throw new Error(`Chain ${chainMeta?.key ?? "?"} has no valid legacy token address`);
  const legacy = {
    address: legacyAddr,
    decimals: toDecimals(chainMeta?.tokens?.legacy?.decimals ?? chainMeta?.decimals ?? 2, `${chainMeta?.key} legacy`),
  };

  const v3cfg = chainMeta?.tokens?.v3;
  let v3 = null;
  if (v3cfg && isAddress(v3cfg.address)) {
    const deployBlock = Number(v3cfg.deployBlock);
    v3 = {
      address: norm(v3cfg.address),
      decimals: toDecimals(v3cfg.decimals, `${chainMeta?.key} v3`),
      deployBlock: Number.isFinite(deployBlock) && deployBlock > 0 ? deployBlock : null,
    };
    if (v3.decimals < legacy.decimals) {
      // The swap maths below scales legacy UP to v3 precision.
      throw new Error(`${chainMeta?.key}: v3 decimals (${v3.decimals}) < legacy (${legacy.decimals}) is unsupported`);
    }
  }

  const escrow = [];
  for (const name of ["tokenMigration", "migrationVault"]) {
    const a = norm(chainMeta?.contracts?.[name]?.address);
    if (isAddress(a) && !escrow.includes(a)) escrow.push(a);
  }
  return { legacy, v3, escrow };
}

/** Parses a Transfer log into {from,to,value:bigint,tx}. null if malformed. */
export function parseTransfer(log) {
  const topics = log?.topics ?? [];
  const data = String(log?.data ?? "").replace("0x", "");
  if (topics.length < 3 || data.length < 64) return null;
  const from = "0x" + String(topics[1]).slice(-40).toLowerCase();
  const to = "0x" + String(topics[2]).slice(-40).toLowerCase();
  if (!isAddress(from) || !isAddress(to)) return null;
  return { from, to, value: BigInt("0x" + data.slice(0, 64)), tx: norm(log.transactionHash) };
}

/** Empty v3 scan state (balances + retired legacy per upgrade contract). */
export const emptyV3State = () => ({ raw: new Map(), retired: new Map() });

/** Rehydrate state from a checkpoint's `v3` section. */
export function v3StateFromCheckpoint(section) {
  const state = emptyV3State();
  for (const [addr, v] of Object.entries(section?.rawBalances ?? {})) state.raw.set(addr, BigInt(v));
  for (const [addr, v] of Object.entries(section?.retired ?? {})) state.retired.set(addr, BigInt(v));
  return state;
}

/** Serialise state for the checkpoint (v3 keeps every positive balance exactly). */
export function v3StateToCheckpoint(state, lastBlock) {
  const rawBalances = {};
  for (const [addr, v] of state.raw) if (v > 0n) rawBalances[addr] = v.toString();
  const retired = {};
  for (const [addr, v] of state.retired) if (v > 0n) retired[addr] = v.toString();
  return { lastBlock, rawBalances, retired };
}

/**
 * Fold one block-range's worth of logs into the v3 state.
 *
 * @param {{raw: Map<string,bigint>, retired: Map<string,bigint>}} state mutated
 * @param {object[]} v3Logs   Transfer logs of the v3 token in the range
 * @param {object[]} escrowLegacyLogs  legacy-token Transfer logs whose `to` is an upgrade contract
 * @param {{escrow: Set<string>|string[], legacyDecimals: number, v3Decimals: number}} cfg
 */
export function applyV3Batch(state, v3Logs, escrowLegacyLogs, cfg) {
  const escrow = new Set([...cfg.escrow].map(norm));
  const scale = pow10(cfg.v3Decimals - cfg.legacyDecimals); // v3 raw per legacy raw unit

  // v3 issued to swappers per tx, in LEGACY raw units.
  const issuedByTx = new Map();
  for (const log of v3Logs) {
    const t = parseTransfer(log);
    if (!t) continue;
    if (t.to !== ZERO_ADDRESS) state.raw.set(t.to, (state.raw.get(t.to) ?? 0n) + t.value);
    if (t.from !== ZERO_ADDRESS) state.raw.set(t.from, (state.raw.get(t.from) ?? 0n) - t.value);
    if ((t.from === ZERO_ADDRESS || escrow.has(t.from)) && t.tx) {
      issuedByTx.set(t.tx, (issuedByTx.get(t.tx) ?? 0n) + t.value / scale);
    }
  }

  const legacyInByTx = new Map();
  for (const log of escrowLegacyLogs) {
    const t = parseTransfer(log);
    if (!t || !escrow.has(t.to) || !t.tx) continue;
    const list = legacyInByTx.get(t.tx) ?? [];
    list.push([t.to, t.value]);
    legacyInByTx.set(t.tx, list);
  }

  for (const [tx, ins] of legacyInByTx) {
    let remaining = issuedByTx.get(tx) ?? 0n;
    for (const [addr, amount] of ins) {
      if (remaining <= 0n) break;
      const take = amount < remaining ? amount : remaining;
      state.retired.set(addr, (state.retired.get(addr) ?? 0n) + take);
      remaining -= take;
    }
  }
}

/**
 * Per-address balance = (legacy - retired) + v3, in TEL, plus the chain's token
 * totals.
 *
 * Dust floor: an address is kept when its combined balance is at least ONE
 * LEGACY RAW UNIT (0.01 TEL at 2 decimals) — the same "any positive balance"
 * floor the legacy-only pipeline used (MIN_TEL_RAW = 1), expressed in TEL so it
 * is identical whether the balance is legacy, v3 or both.
 *
 * @param {object} p
 * @param {Map<string,bigint>} p.legacyRaw
 * @param {number} p.legacyDecimals
 * @param {Map<string,bigint>} [p.v3Raw]
 * @param {number} [p.v3Decimals]
 * @param {Map<string,bigint>} [p.retired] legacy raw units retired per upgrade contract
 * @returns {{ balances: Map<string,number>, v3ByAddress: Map<string,number>,
 *             totals: {legacy:number, v3:number, retiredLegacy:number},
 *             negativeRetired: string[] }}
 */
export function combineChainBalances({ legacyRaw, legacyDecimals, v3Raw = new Map(), v3Decimals = 18, retired = new Map() }) {
  const common = Math.max(legacyDecimals, v3Raw.size > 0 ? v3Decimals : legacyDecimals);
  const legacyScale = pow10(common - legacyDecimals);
  const v3Scale = pow10(Math.max(0, common - v3Decimals));
  const floor = pow10(common - legacyDecimals); // one legacy raw unit, at common precision

  const addresses = new Set([...legacyRaw.keys(), ...v3Raw.keys()]);
  const balances = new Map();
  const v3ByAddress = new Map();
  const negativeRetired = [];
  let legacyTotal = 0n;
  let v3Total = 0n;
  let retiredTotal = 0n;

  for (const [addr, r] of retired) if (r > 0n) retiredTotal += r;

  for (const addr of addresses) {
    const legacyGross = legacyRaw.get(addr) ?? 0n;
    const v3 = v3Raw.get(addr) ?? 0n;
    if (legacyGross > 0n) legacyTotal += legacyGross;
    if (v3 > 0n) v3Total += v3;

    const retiredHere = retired.get(addr) ?? 0n;
    let legacyNet = legacyGross - retiredHere;
    if (legacyNet < 0n) {
      // A negative RAW legacy balance is an ordinary scan artifact (outflows of
      // TEL received before the scan window) and, as in the legacy-only pipeline,
      // contributes nothing. But retiring MORE than an upgrade contract holds can
      // only mean its scan is incomplete — report that one, and clamp either way
      // so a holder is never negative.
      if (retiredHere > 0n) negativeRetired.push(addr);
      legacyNet = 0n;
    }
    const total = legacyNet * legacyScale + (v3 > 0n ? v3 * v3Scale : 0n);
    if (total < floor) continue;
    balances.set(addr, roundTel(rawToTel(total, common)));
    if (v3 > 0n) v3ByAddress.set(addr, roundTel(rawToTel(v3, v3Decimals)));
  }

  return {
    balances,
    v3ByAddress,
    totals: {
      legacy: rawToTel(legacyTotal, legacyDecimals),
      v3: v3Raw.size > 0 ? rawToTel(v3Total, v3Decimals) : 0,
      retiredLegacy: rawToTel(retiredTotal, legacyDecimals),
    },
    negativeRetired,
  };
}

/**
 * First block the legacy scan of each chain started at when a checkpoint carries no
 * `fromBlock` of its own (every checkpoint written before this field existed).
 */
export const LEGACY_SCAN_START = Object.freeze({ ethereum: 4_600_000, polygon: 21_500_000, base: 100_000 });

/**
 * A resumed legacy scan is only exact if the checkpoint's balances were built from
 * the SAME start block as the configured one. Balances are replayed from zero, so a
 * checkpoint built from a later block misses every holder whose balance had already
 * been set earlier and has not moved since (Polygon: the scan used to start at block
 * 21.5M although the token was deployed at 11.26M, leaving ~298M TEL of untouched
 * early holders out of the supply). Negative interim balances are not stored, so the
 * missing history cannot be patched in: the legacy checkpoint must be rebuilt.
 *
 * @returns {{usable: boolean, startedAt: number|null}}
 */
export function legacyCheckpointUsable(chainKey, checkpoint, configuredFromBlock) {
  if (!checkpoint || !checkpoint.rawBalances) return { usable: false, startedAt: null };
  const startedAt = Number.isFinite(Number(checkpoint.fromBlock))
    ? Number(checkpoint.fromBlock)
    : (LEGACY_SCAN_START[chainKey] ?? null);
  return { usable: startedAt === configuredFromBlock, startedAt };
}
