/**
 * Pure supply reconciliation helpers — buckets every wallet's TEL once.
 */

// The token's own totalSupply() on the origin chain. Not a guess and not a
// third-party figure — read from the contract. CoinGecko reports the same.
export const TEL_TOTAL_SUPPLY = 100_000_000_000;
// Tolerance for the derived total vs the contract's totalSupply(). Transfer-log
// reconstruction misses sub-threshold dust, so exact equality is not expected.
export const RECONCILE_TOLERANCE = 0.01; // 1%
// CoinGecko's reported circulating supply, for comparison only. Traced
// 2026-08: their implied non-circulating amount (100B - this) equals
// treasury 0x2580…'s exact balance right after its 2025-10-01 transfer to
// Anchorage (4,922,764,633, within 1,000 TEL) — a frozen snapshot from that
// date, not a live read or a different methodology.
export const COINGECKO_CIRCULATING = 95_077_236_367;

const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/**
 * Buckets every wallet's balance, counting each TEL exactly once.
 *
 * Bridge-lock contracts are dropped rather than bucketed: the TEL they hold is
 * already represented by the mirrored tokens on Polygon/Base, so counting both
 * is the double-count this whole exercise exists to prevent.
 */
export const buildReconciliation = (snapshot, exclusions, cexWallets) => {
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
    const eth = Number(wallet?.ethereum_balance) || 0;
    const pol = Number(wallet?.polygon_balance) || 0;
    const base = Number(wallet?.base_balance) || 0;
    originTotal += eth;
    mirrored += pol + base;

    if (bridgeSet.has(address)) {
      bridgeLocked += eth;
      items.push({
        address,
        category: "bridge-lock",
        name: labels[address]?.name ?? null,
        balance: eth,
        counted: false,
      });
      continue;
    }

    const balance = eth + pol + base;

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
  // Escrow (Anchorage / BitGo) stays in circulating by default — matches
  // market-data convention (CoinGecko only carves treasury). Council and
  // treasury stay out, and any address with a nonCirculatingOverride (TEL
  // contractually committed elsewhere, e.g. a SAFE's return-to-treasury
  // clause) is carved out too, regardless of its category.
  const circulating =
    counted - (categories.treasury ?? 0) - (categories.council ?? 0) - nonCirculatingExclusions;

  // Identity: counted + residual === totalSupply.
  // residual ≈ bridgeInFlight − originDrift, where bridgeInFlight is L1 lock
  // ahead of L2 mirrors and originDrift is eth-scan overshoot vs contract.
  const originDrift = originTotal - TEL_TOTAL_SUPPLY;
  const bridgeInFlight = bridgeLocked - mirrored;
  const residual = TEL_TOTAL_SUPPLY - counted;

  items.sort((a, b) => b.balance - a.balance);

  return {
    totalSupply: TEL_TOTAL_SUPPLY,
    derivedOriginTotal: originTotal,
    bridgeLocked,
    mirrored,
    // Mirrored supply must be backed 1:1 by TEL locked on the origin chain.
    mirrorResidual: mirrored - bridgeLocked,
    residual,
    residualParts: {
      bridgeInFlight,
      originDrift,
    },
    categories,
    counted,
    circulating,
    circulatingExclusions: {
      total: nonCirculatingExclusions,
      items: circulatingExclusionItems,
    },
    warnings,
    coingeckoCirculating: COINGECKO_CIRCULATING,
    items,
  };
};
