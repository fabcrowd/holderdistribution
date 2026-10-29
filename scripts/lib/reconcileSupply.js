/**
 * Pure supply reconciliation helpers — buckets every wallet's TEL once.
 */
import { normalizeAnyAddress } from "./address.js";
import { DEFAULT_CIRCULATING_SUBTRACT, subtractedTotal } from "./circulatingSubtract.js";

// The token's own totalSupply() on the origin chain. Not a guess and not a
// third-party figure — read from the contract. CoinGecko reports the same.
export const TEL_TOTAL_SUPPLY = 100_000_000_000;
// Tolerance for the derived total vs the contract's totalSupply(). Transfer-log
// reconstruction misses sub-threshold dust, so exact equality is not expected.
export const RECONCILE_TOLERANCE = 0.01; // 1%
// TEL-only traced CoinGecko snapshot, for comparison only. Traced 2026-08:
// their implied non-circulating amount (100B - this) equals treasury
// 0x2580…'s exact balance right after its 2025-10-01 transfer to Anchorage
// (4,922,764,633, within 1,000 TEL). scripts/lib/coingeckoCirculating.js
// applies it solely to a project whose config sets
// supply.coingeckoSnapshotFallback (TEL) when CoinGecko has no positive live
// circulating supply. It is not a default for any other project.
export const COINGECKO_CIRCULATING = 95_077_236_367;

// Hex lowercased, Solana base58 kept as written (case-sensitive).
const norm = (v) => normalizeAnyAddress(v);

/**
 * Buckets every wallet's balance, counting each TEL exactly once.
 *
 * Bridge-lock contracts are dropped rather than bucketed: the TEL they hold is
 * already represented by the mirrored tokens on Polygon/Base, so counting both
 * is the double-count this whole exercise exists to prevent.
 */
export const buildReconciliation = (
  snapshot,
  exclusions,
  cexWallets,
  // Per-project overrides (scripts/reconcile-supply.js passes the project's
  // supply.target and a per-project CoinGecko read). totalSupply still
  // defaults to TEL's 100B for callers that omit it. coingeckoCirculating
  // defaults to null: omitting it hides the comparison rather than borrowing
  // TEL's snapshot. `chains` (ordered keys) and `origin` come from the
  // project's chains[] when the snapshot does not name them; `upgrade`
  // ({ generation }) names the upgraded-token generation (default "v3").
  // `circulatingSubtract` = category keys held out of circulating (project
  // config supply.circulating.subtract; see circulatingSubtract.js).
  {
    totalSupply = TEL_TOTAL_SUPPLY,
    coingeckoCirculating = null,
    chains = null,
    origin = null,
    upgrade = null,
    circulatingSubtract = DEFAULT_CIRCULATING_SUBTRACT,
  } = {},
) => {
  const TOTAL_SUPPLY = totalSupply;
  const upgradeGeneration = upgrade?.generation ?? "v3";
  // Per-token ledger written by pull-holders-rpc.js (scripts/lib/supply.js).
  // Absent in pre-v3 snapshots, where every v3/retired term is zero and the
  // wallet sums ARE the legacy supply.
  const tokens = snapshot?.totals?.tokens ?? null;
  // Wallet columns are `<chainKey>_balance`; the snapshot's chainOrder names
  // them, else the project's chains[] order, else whatever columns the wallets
  // carry. Mirrors = every non-origin chain.
  const chainKeys = snapshot?.chainOrder?.length
    ? snapshot.chainOrder
    : chains?.length
      ? chains
      : Object.keys(snapshot?.wallets?.[0] ?? {})
          .filter((k) => k.endsWith("_balance"))
          .map((k) => k.slice(0, -"_balance".length));
  // Generic bridge-netting snapshot (scripts/lib/supply.js
  // computeBridgeNettedSupply): only lock-mint chains are mirrors; native /
  // burn-mint chains are real supply, counted like the origin.
  const bridgeModes = snapshot?.totals?.method === "bridge-netting" ? snapshot?.totals?.bridgeModes ?? {} : null;
  const originKey = snapshot?.totals?.originChain ?? (origin ?? chainKeys[0]);
  const mirrorKeys = bridgeModes
    ? chainKeys.filter((k) => k !== originKey && bridgeModes[k] === "lock-mint")
    : chainKeys.filter((k) => k !== originKey);
  const ownSupplyKeys = bridgeModes ? chainKeys.filter((k) => k !== originKey && !mirrorKeys.includes(k)) : [];
  const sumTokens = (map, keys) => keys.reduce((acc, k) => acc + (Number(map?.[k]) || 0), 0);

  const labels = exclusions?.labels ?? {};
  const excludedSet = new Set((exclusions?.addresses ?? []).map(norm).filter(Boolean));
  // Per-chain exclusion lists must count too — every other consumer flattens
  // them into the global set. Ignoring them here would under-count excluded
  // TEL the moment any chains.*.addresses entry is populated.
  for (const chain of Object.values(exclusions?.chains ?? {})) {
    for (const a of chain?.addresses ?? []) {
      const n = norm(a);
      if (n) excludedSet.add(n);
    }
  }
  const cexSet = new Set(
    (cexWallets?.wallets ?? []).map((w) => norm(w?.address)).filter(Boolean),
  );
  const bridgeSet = new Set(
    Object.entries(labels)
      .filter(([, meta]) => meta?.category === "bridge-lock")
      .map(([addr]) => norm(addr)),
  );
  // Origin bridge/escrow contracts from the project's contracts{} roles.
  if (bridgeModes && mirrorKeys.length) for (const a of snapshot?.totals?.lockAddresses ?? []) bridgeSet.add(norm(a));

  const categories = {};
  const items = [];
  let bridgeLocked = 0;
  let mirrored = 0;
  let originTotal = 0;
  let nonCirculatingExclusions = 0;
  const circulatingExclusionItems = [];
  const warnings = [];

  const add = (key, amount) => {
    categories[key] = (categories[key] ?? 0) + amount;
  };

  for (const wallet of snapshot?.wallets ?? []) {
    const address = norm(wallet?.address);
    const eth = Number(wallet?.[`${originKey}_balance`]) || 0; // origin chain
    const mirrorBalance = mirrorKeys.reduce((acc, k) => acc + (Number(wallet?.[`${k}_balance`]) || 0), 0);
    const ownSupplyBalance = ownSupplyKeys.reduce((acc, k) => acc + (Number(wallet?.[`${k}_balance`]) || 0), 0);
    originTotal += eth + ownSupplyBalance;
    mirrored += mirrorBalance;

    if (bridgeSet.has(address)) {
      // Bridge locks hold legacy TEL only; a stray v3 balance is not backing.
      bridgeLocked += eth - (Number(wallet?.[`${originKey}_${upgradeGeneration}`]) || 0);
      items.push({
        address,
        category: "bridge-lock",
        name: labels[address]?.name ?? null,
        balance: eth,
        counted: false,
      });
      continue;
    }

    const balance = eth + mirrorBalance + ownSupplyBalance;

    // nonCirculatingOverride is orthogonal to category: it says how much of
    // THIS address's balance is contractually committed elsewhere (e.g. a
    // SAFE's return-to-treasury clause), independent of which bucket the
    // wallet's *location* belongs in. Checked before the balance<=0 exit
    // below so a wallet drained to zero — the most extreme case of "the
    // committed amount already moved" — still warns instead of silently
    // dropping the exclusion. Clamped to the actual balance so a stale
    // override can never over-subtract from circulating.
    const rawOverride = Number(labels[address]?.nonCirculatingOverride) || 0;
    if (rawOverride > 0) {
      const applied = Math.min(rawOverride, Math.max(balance, 0));
      nonCirculatingExclusions += applied;
      circulatingExclusionItems.push({ address, name: labels[address]?.name ?? null, amount: applied });
      if (rawOverride > balance) {
        warnings.push(
          `${address} (${labels[address]?.name ?? "unnamed"}): nonCirculatingOverride ` +
            `${rawOverride} exceeds current balance ${balance} — clamped to ${applied}. ` +
            `The committed amount may have already moved; re-verify the override.`,
        );
      }
    }

    if (balance <= 0) continue;

    const labelled = labels[address]?.category;
    const category =
      labelled ?? (cexSet.has(address) ? "cex" : excludedSet.has(address) ? "excluded-unlabelled" : "retail");
    add(category, balance);

    if (category !== "retail") {
      items.push({
        address,
        category,
        name: labels[address]?.name ?? null,
        balance,
        counted: true,
        ...(rawOverride > 0 ? { nonCirculatingOverride: rawOverride } : {}),
      });
    }
  }

  const counted = Object.values(categories).reduce((sum, v) => sum + v, 0);
  // Which categories leave circulating is per-project config
  // (supply.circulating.subtract). Escrow (Anchorage / BitGo) stays in
  // circulating unless listed — matches market-data convention (CoinGecko
  // only carves treasury). Any address with a nonCirculatingOverride (TEL
  // contractually committed elsewhere, e.g. a SAFE's return-to-treasury
  // clause) is carved out too, regardless of its category.
  const circulating = counted - subtractedTotal(categories, circulatingSubtract) - nonCirculatingExclusions;

  // Identity: counted + residual === totalSupply.
  // residual ≈ bridgeInFlight − originDrift, where bridgeInFlight is L1 lock
  // ahead of L2 mirrors and originDrift is eth-scan overshoot vs contract.
  //
  // With v3 the wallet sums are no longer the legacy supply (legacy swapped into
  // v3 is netted out of the upgrade contract's wallet, and v3 is added to its
  // new holders), so the origin total and the mirror total come from the scan's
  // per-token ledger instead, and one more residual term appears:
  //   residual = bridgeInFlight − originDrift + (retiredLegacy − v3Supply)
  // where the last term is v3 not yet backed by retired legacy (≈ 0, in-flight).
  const retiredTotal = tokens ? sumTokens(tokens.retiredLegacy, Object.keys(tokens.retiredLegacy ?? {})) : 0;
  const v3Total = tokens ? sumTokens(tokens[upgradeGeneration], Object.keys(tokens[upgradeGeneration] ?? {})) : 0;
  const derivedOrigin = bridgeModes
    ? Number(snapshot?.totals?.totalSupply) || originTotal // origin + native/burn-mint supply
    : tokens ? Number(tokens.legacy?.[originKey]) || 0 : originTotal;
  const mirroredLegacy = bridgeModes
    ? (tokens ? sumTokens(tokens.legacy, mirrorKeys) : mirrored)
    : tokens
      ? sumTokens(tokens.legacy, Object.keys(tokens.legacy ?? {}).filter((k) => k !== originKey))
      : mirrored;
  const originDrift = derivedOrigin - TOTAL_SUPPLY;
  const bridgeInFlight = bridgeLocked - mirroredLegacy;
  const upgradeUnbacked = retiredTotal - v3Total;
  const residual = TOTAL_SUPPLY - counted;
  items.sort((a, b) => b.balance - a.balance);

  return {
    totalSupply: TOTAL_SUPPLY,
    derivedOriginTotal: derivedOrigin,
    bridgeLocked,
    mirrored: mirroredLegacy,
    // Mirrored supply must be backed 1:1 by TEL locked on the origin chain.
    mirrorResidual: mirroredLegacy - bridgeLocked,
    residual,
    residualParts: {
      bridgeInFlight,
      originDrift,
      // Legacy retired into v3 minus v3 supply. Zero before the upgrade; a
      // non-zero value is v3 minted without a matching swap, or bridge in-flight.
      upgradeUnbacked,
    },
    ...(tokens
      ? {
          upgrade: {
            // Legacy TEL locked in the upgrade contracts in exchange for minted
            // v3. Excluded from every bucket below (the v3 is counted instead).
            retiredLegacy: retiredTotal,
            retiredLegacyByChain: { ...tokens.retiredLegacy },
            v3Supply: v3Total,
            v3SupplyByChain: { ...tokens[upgradeGeneration] },
            legacySupplyByChain: { ...tokens.legacy },
            // Legacy sent to an upgrade contract with no swap: counted once, on
            // the contract's own (escrow-labelled) wallet.
            strandedInUpgrade: sumTokens(tokens.strandedInUpgrade, Object.keys(tokens.strandedInUpgrade ?? {})),
            strandedInUpgradeByChain: { ...tokens.strandedInUpgrade },
          },
        }
      : {}),
    categories,
    counted,
    circulating,
    circulatingExclusions: {
      total: nonCirculatingExclusions,
      items: circulatingExclusionItems,
    },
    warnings,
    coingeckoCirculating,
    items,
  };
};

/**
 * Merges a project's contracts{} role addresses into its exclusions labels so
 * buildReconciliation buckets them (treasury, staking, ...) instead of retail.
 * `roleEntriesByChain` is projectRoleAddresses() output; `categoryByRole` maps
 * role -> supply category (ROLE_SUPPLY_CATEGORIES). A Solana contracts{} entry
 * may name a token account whose holder row is its OWNER, so the owner from
 * `snapshot.tokenAccountOwnersByChain[chainKey][address]` is labelled too
 * (same idea as pull-holders-rpc.js). Existing labels always win, so a project
 * whose exclusions file already labels everything is unchanged.
 * Returns a new exclusions object; the input is not mutated.
 */
export const mergeRoleExclusions = (exclusions, roleEntriesByChain, categoryByRole, ownersByChain = {}) => {
  const labels = { ...(exclusions?.labels ?? {}) };
  const addresses = [...(exclusions?.addresses ?? [])];
  const known = new Set(addresses.map(norm).filter(Boolean));
  const labelOne = (raw, meta) => {
    const address = norm(raw);
    if (!address) return;
    if (!labels[address]) labels[address] = meta;
    if (!known.has(address)) {
      known.add(address);
      addresses.push(address);
    }
  };
  for (const [chainKey, entries] of Object.entries(roleEntriesByChain ?? {})) {
    const owners = ownersByChain?.[chainKey] ?? {};
    for (const { name, address, role } of entries ?? []) {
      const category = categoryByRole?.[role];
      if (!category) continue;
      labelOne(address, { category, name: name ?? null, source: "contracts" });
      const owner = owners[address];
      if (owner && owner !== address) {
        labelOne(owner, { category, name: name ? `${name} (token account owner)` : null, source: "contracts-owner" });
      }
    }
  }
  return { ...(exclusions ?? {}), addresses, labels };
};
