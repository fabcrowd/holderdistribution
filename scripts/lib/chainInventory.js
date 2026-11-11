/**
 * chainInventory.js — onboarding step 1, "chain & contract discovery".
 *
 * config/projects/<slug>/chains-inventory.json records EVERY chain the token is
 * known on (configured or not) with its contract / mint, decimals, explorer
 * link, total supply on that chain and the source of each fact. Seeding and the
 * site UI are scoped from it, so a chain cannot be silently missed.
 *
 * validateInventory(config, inventory) is the gate add-project.js and CI use:
 *   - every chains[] entry and token address in the config appears in the
 *     inventory as status "configured" with the same address;
 *   - every other inventory row is "excluded" or "not-found" with a reason
 *     (a "candidate" left undecided fails);
 *   - every row names a source.
 */

export const INVENTORY_STATUSES = Object.freeze(["configured", "candidate", "excluded", "not-found"]);
export const inventoryRelPath = (slug) => `config/projects/${slug}/chains-inventory.json`;

const norm = (vm, a) => (vm === "solana" ? String(a ?? "") : String(a ?? "").toLowerCase());

/** Token addresses a config chain declares (array or legacy/v3 object or tokenAddress). */
export function configChainTokens(chain) {
  if (chain?.asset?.kind === "native") return [{ address: "native", decimals: chain.asset.decimals }];
  const t = chain?.tokens;
  const list = Array.isArray(t) ? t : t && typeof t === "object" ? Object.entries(t).map(([generation, v]) => ({ generation, ...v })) : [];
  if (!list.length && chain?.tokenAddress) list.push({ address: chain.tokenAddress, decimals: chain.decimals });
  return list.filter((x) => x?.address);
}

export function validateInventory(config, inv) {
  const errors = [];
  if (!inv || !Array.isArray(inv.chains)) return ["chains-inventory.json missing or has no chains[] (run scripts/chain-inventory.js)"];
  if (inv.slug && config?.slug && inv.slug !== config.slug) errors.push(`inventory slug ${inv.slug} != project ${config.slug}`);
  const byChain = new Map(inv.chains.map((r) => [r.chain, r]));
  for (const c of config?.chains ?? []) {
    const vm = c.vm ?? "evm";
    const row = byChain.get(c.key);
    if (!row) {
      errors.push(`${c.key}: configured chain missing from the inventory`);
      continue;
    }
    if (row.status !== "configured") errors.push(`${c.key}: configured in chains[] but inventory status is ${row.status}`);
    const have = new Set((row.tokens ?? []).map((t) => norm(vm, t.address)));
    for (const t of configChainTokens(c)) if (!have.has(norm(vm, t.address))) errors.push(`${c.key}: token ${t.address} not in the inventory`);
  }
  const configured = new Set((config?.chains ?? []).map((c) => c.key));
  for (const r of inv.chains) {
    if (!INVENTORY_STATUSES.includes(r.status)) errors.push(`${r.chain}: unknown status ${r.status}`);
    if (!r.source || !String(r.source).trim()) errors.push(`${r.chain}: needs a source (explorer, docs, CoinGecko, RPC)`);
    if (r.status === "configured" && !configured.has(r.chain)) errors.push(`${r.chain}: inventory says configured but chains[] has no such chain`);
    if (r.status === "candidate") errors.push(`${r.chain}: undecided candidate — add it to chains[] or mark it "excluded" with a reason`);
    if ((r.status === "excluded" || r.status === "not-found") && !String(r.reason ?? "").trim()) errors.push(`${r.chain}: ${r.status} needs a reason`);
  }
  return errors;
}

/**
 * Build an inventory from config + a detect-token-chains.js report + measured
 * supplies. Pure; the CLI (scripts/chain-inventory.js) does the network reads.
 *   supplies: { [chain]: { [address]: number } }  totalSupply in whole tokens
 *   extra:    manual rows [{ chain, vm, status, tokens, source, reason }]
 */
export function buildInventory({ project, discovery = null, supplies = {}, coingecko = null, extra = [], explorerUrl = () => null, now = new Date() }) {
  const cfg = project.config;
  const rows = new Map();
  for (const c of cfg.chains ?? []) {
    const vm = c.vm ?? "evm";
    rows.set(c.key, {
      chain: c.key,
      vm,
      status: "configured",
      tokens: configChainTokens(c).map((t) => ({
        address: t.address,
        decimals: t.decimals ?? null,
        generation: t.generation ?? null,
        tokenStatus: t.status ?? null,
        explorer: c.asset?.kind === "native" ? null : explorerUrl(c, t.address),
        totalSupply: supplies?.[c.key]?.[t.address] ?? null,
      })),
      source: `config/projects/${project.slug}.json chains[]` + (supplies?.[c.key] ? "; totalSupply via public RPC" : ""),
    });
  }
  for (const d of discovery?.chains ?? []) {
    if (rows.has(d.chain)) continue;
    const found = d.status === "candidate" || d.status === "listed-unverified";
    rows.set(d.chain, {
      chain: d.chain,
      vm: d.chain === "solana" ? "solana" : "evm",
      status: found ? "candidate" : "not-found",
      tokens: d.address ? [{ address: d.address, decimals: d.decimals ?? null, explorer: null, totalSupply: null }] : [],
      source: `scripts/detect-token-chains.js (${(discovery.methods ?? []).join(", ")}) ${discovery.checkedAt ?? ""}`.trim(),
      reason: found ? null : `detect-token-chains: ${d.status}`,
    });
  }
  for (const e of extra) rows.set(e.chain, { ...rows.get(e.chain), ...e });
  const chains = [...rows.values()];
  const totals = chains.flatMap((r) => (r.status === "configured" ? r.tokens : [])).filter((t) => t.tokenStatus !== "deprecated" && Number.isFinite(t.totalSupply));
  const sum = totals.reduce((a, t) => a + t.totalSupply, 0);
  for (const r of chains) {
    for (const t of r.tokens ?? []) if (Number.isFinite(t.totalSupply) && sum > 0 && t.tokenStatus !== "deprecated") t.supplyShare = Math.round((t.totalSupply / sum) * 10000) / 10000;
  }
  return {
    $comment: "Onboarding step 1 (docs/MULTI-TOKEN.md): every chain the token is on, configured or not, with sources. Regenerate with scripts/chain-inventory.js; add/override rows with --extra. Excluded/not-found rows need a reason.",
    schemaVersion: 1,
    slug: project.slug,
    ticker: cfg.ticker ?? null,
    generatedAt: now.toISOString(),
    coingecko,
    chains,
  };
}
