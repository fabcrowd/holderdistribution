/**
 * Per-project inputs for the GATED wallet-flows report
 * (scripts/generate-wallet-flows.js). Pure path/config resolution, no network,
 * so tests can check every project resolves under its own slug.
 *
 * Layout (docs/MULTI-TOKEN.md "Gated forensics"):
 *   TEL (data.legacyRoot)  data/forensics/wallet-flows{,.registry}.json  (unchanged)
 *   any other project      data/<slug>/forensics/wallet-flows{,.registry}.json
 * Both live under data/, never public/, so nothing here is deployed; the
 * forensics gate function is the only reader on the site.
 *
 * Optional project config: `gated.walletFlows`:
 *   coingeckoId      CoinGecko simple/price id for USD values (none = carried over / 0)
 *   chains           chain keys to scan (default: every chain in the project's chain map)
 *   bridgeAddresses  bridge infrastructure counted as "bridge" outflows
 *   dexVenues        extra DEX routers / aggregators (on top of classification.dexContracts)
 *   logSpan          { <chainKey>: initial getLogs span }
 */
import path from "node:path";
import { BRIDGE_INFRA, DEX_VENUES } from "./telEndpoint.js";
import { projectChains, projectClassificationPath, projectPaths, projectWork } from "./projects.js";

/** TEL's original getLogs spans; other chains start at DEFAULT_LOG_SPAN (rpc.getLogs bisects anyway). */
export const TEL_LOG_SPAN = { ethereum: 20_000, polygon: 50_000, base: 50_000 };
export const DEFAULT_LOG_SPAN = 50_000;

export const WALLET_FLOWS_FILE = "forensics/wallet-flows.json";
export const WALLET_FLOWS_REGISTRY_FILE = "forensics/wallet-flows.registry.json";

const lc = (a) => String(a).trim().toLowerCase();

const optValue = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

/**
 * Resolve every input/output of generate-wallet-flows for `project`.
 * `--out` / `--recon` / `--chains` CLI overrides still work (repo-relative).
 */
export function walletFlowsPlan(project, { root = process.cwd(), argv = [] } = {}) {
  const legacy = project.config?.data?.legacyRoot === true;
  const cfg = project.config?.gated?.walletFlows ?? {};
  const data = projectPaths(project, root);
  const work = projectWork(project, root);
  const chainsCfg = projectChains(project, root);

  const chainsArg = optValue(argv, "--chains");
  const chains = (chainsArg ? chainsArg.split(",") : cfg.chains ?? Object.keys(chainsCfg))
    .map((c) => String(c).trim())
    .filter(Boolean);
  for (const c of chains) if (!chainsCfg[c]) throw new Error(`wallet-flows: chain "${c}" is not in ${project.slug}'s chain map`);

  const outArg = optValue(argv, "--out");
  const reconArg = optValue(argv, "--recon");
  const bridge = new Set([...(legacy ? BRIDGE_INFRA : []), ...(cfg.bridgeAddresses ?? []).map(lc)]);
  // DEX_VENUES are chain-wide aggregators (CoW, 1inch, Kyber, 0x), not TEL contracts.
  const dexVenues = [...new Set([...DEX_VENUES.keys(), ...(cfg.dexVenues ?? []).map(lc)])];

  return {
    slug: project.slug,
    name: project.config?.name ?? project.slug,
    ticker: project.config?.ticker ?? project.slug.toUpperCase(),
    legacy,
    out: outArg ? path.resolve(root, outArg) : work(WALLET_FLOWS_FILE),
    registry: work(WALLET_FLOWS_REGISTRY_FILE),
    recon: reconArg ? path.resolve(root, reconArg) : data("supply-reconciliation.json"),
    chainsCfg,
    chains,
    cexPath: projectClassificationPath(project, "cexWallets", root),
    dexPath: projectClassificationPath(project, "dexContracts", root),
    coingeckoId: cfg.coingeckoId ?? null,
    bridgeAddresses: [...bridge],
    dexVenues,
    logSpan: (chain) => cfg.logSpan?.[chain] ?? (legacy ? TEL_LOG_SPAN[chain] : undefined) ?? DEFAULT_LOG_SPAN,
  };
}

/**
 * Report notes. TEL's wording is unchanged (the committed report and the gated
 * view quote it); other projects get the same notes with their ticker / name.
 */
export function walletFlowsNotes({ legacy, ticker, name }) {
  if (legacy) {
    return [
      "Outflows are first-hop TEL transfers (legacy + v3) from each wallet, classified by destination; sends to known deposit relays count as CEX.",
      "Reaching a sell venue is not proof of a market sale: it can be market making, OTC settlement or treasury operations.",
      "Labels marked medium/low confidence come from this repo's own forensics, not from Telcoin.",
      "USD values use the price above and are rough.",
    ];
  }
  return [
    `Outflows are first-hop ${ticker} transfers from each wallet, classified by destination; sends to known deposit relays count as CEX.`,
    "Reaching a sell venue is not proof of a market sale: it can be market making, OTC settlement or treasury operations.",
    `Labels marked medium/low confidence come from this repo's own forensics, not from ${name}.`,
    "USD values use the price above and are rough.",
  ];
}

/** address -> { decimals, slot: "legacy" | "v3" } for one chain's tokens (TEL: legacy = 2 dp, v3 = 18 dp). */
export function tokenSlots(tokens) {
  const m = new Map([[tokens.legacy.address, { decimals: tokens.legacy.decimals, slot: "legacy" }]]);
  if (tokens.v3) m.set(tokens.v3.address, { decimals: tokens.v3.decimals, slot: "v3" });
  return m;
}
