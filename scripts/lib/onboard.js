/**
 * Pure parts of `npm run onboard` (scripts/onboard.js): turn on-chain facts,
 * a CoinGecko listing and a detect-token-chains report into the exact
 * add-project.js arguments and a validated chains inventory. Every network
 * read is injected, so this file never touches RPC or HTTP itself.
 */
import { isEvmAddress, isSolanaAddress } from "./address.js";
import { buildInventory } from "./chainInventory.js";
import { CANDIDATE_CHAINS, SOLANA_CANDIDATE } from "./tokenChains.js";
import { SLUG_RE } from "./projects.js";

/** "evm" | "solana" | "hedera" | null from the shape of the address the owner gave. */
export function inferVm(address) {
  const a = String(address ?? "").trim();
  if (isEvmAddress(a)) return "evm";
  if (/^0\.0\.\d+$/.test(a)) return "hedera";
  if (isSolanaAddress(a)) return "solana";
  return null;
}

/** CoinGecko platform id for a chain key (null when we do not know it). */
export const coingeckoPlatformFor = (chainKey) =>
  chainKey === "solana" ? SOLANA_CANDIDATE.coingecko : (CANDIDATE_CHAINS.find((c) => c.key === chainKey)?.coingecko ?? null);

/** A registry slug from a CoinGecko id or a display name: lower-case, [a-z0-9-], 32 chars max. */
export function slugify(value) {
  const s = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return SLUG_RE.test(s) ? s : null;
}

/** Whole tokens from a raw integer supply (string or bigint); floors sub-token dust. */
export function wholeTokens(raw, decimals) {
  const v = BigInt(raw) / 10n ** BigInt(decimals);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`supply ${v} whole tokens is too large to store as a number`);
  return n;
}

/**
 * Lowest block at which `hasCode(block)` is true (the contract's deploy block),
 * by binary search over [0, latest]. ~log2(latest) calls (about 25 on Ethereum).
 * Returns null when the node cannot answer historical state (not an archive node).
 */
export async function findDeployBlock({ latest, hasCode }) {
  if (!(await hasCode(latest))) return null;
  let lo = 0;
  let hi = latest;
  try {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1;
    }
  } catch {
    return null;
  }
  return lo;
}

/** File extension for a token image URL (CoinGecko serves png/jpg/webp/svg); png if unclear. */
export function imageExt(url) {
  const m = String(url ?? "").split("?")[0].match(/\.(png|jpe?g|webp|svg)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

const EXCLUDE_REASON = (row) =>
  `Found by detect-token-chains (${row.chain}, ${row.tokens?.[0]?.address ?? "no address"}) but not configured at onboarding: ` +
  "the bridge type (native / lock-mint / burn-mint) is unconfirmed. Re-run onboard.js with --include " +
  `${row.chain} once it is confirmed.`;

/**
 * Everything onboard.js needs to call add-project.js.
 *
 * @param {object} p
 * @param {string} p.address token contract or mint on the origin chain
 * @param {string} p.chain origin chain key (ethereum, polygon, ..., solana)
 * @param {{symbol:string|null,name:string|null,decimals:number,totalSupplyRaw:string,deployBlock:number|null,deployDate:string|null}} p.facts
 * @param {{id?:string,name?:string,symbol?:string,image?:string}|null} p.coingecko
 * @param {object|null} p.discovery detect-token-chains report ({ chains: [...] })
 * @param {Record<string,{address:string,decimals:number}>} [p.included] extra chains to configure, by key
 * @param {{slug?:string,name?:string,ticker?:string,historyStart?:string,wallets?:string[]}} [p.overrides]
 * @param {Date} [p.now]
 */
export function planOnboarding({ address, chain, facts, coingecko = null, discovery = null, included = {}, overrides = {}, now = new Date() }) {
  const notes = [];
  if (!Number.isInteger(facts?.decimals)) throw new Error(`${chain}: decimals could not be read on-chain; stop (onboarding runbook step 2)`);
  if (facts.totalSupplyRaw == null) throw new Error(`${chain}: total supply could not be read on-chain; stop (onboarding runbook step 2)`);

  const ticker = String(overrides.ticker ?? facts.symbol ?? coingecko?.symbol ?? "").trim().toUpperCase();
  if (!ticker) throw new Error("no ticker: the token has no symbol() and no CoinGecko listing; pass --ticker");
  const name = String(overrides.name ?? coingecko?.name ?? facts.name ?? ticker).trim();
  // The display name reads better in a URL than a CoinGecko id ("jupiter", not "jupiter-exchange-solana").
  const slug = overrides.slug ?? slugify(name) ?? slugify(coingecko?.id);
  if (!slug || !SLUG_RE.test(slug)) throw new Error(`no usable slug from "${coingecko?.id ?? name}"; pass --slug`);

  const isSolana = chain === "solana";
  const origin = { key: chain, address: isSolana ? address : address.toLowerCase(), decimals: facts.decimals };
  const chainSpecs = [
    isSolana
      ? `solana:${origin.address}:${origin.decimals}`
      : `${chain}:${origin.address}:${origin.decimals}${facts.deployBlock != null ? `:${CANDIDATE_CHAINS.find((c) => c.key === chain)?.chainId ?? ""}:${facts.deployBlock}` : ""}`,
  ];
  for (const [key, t] of Object.entries(included)) {
    chainSpecs.push(key === "solana" ? `solana:${t.address}:${t.decimals}` : `${key}:${t.address.toLowerCase()}:${t.decimals}`);
    notes.push(`${key}: configured as bridge "lock-mint" by default; confirm the bridge type in config/projects/${slug}.json`);
  }
  if (!isSolana && facts.deployBlock == null) notes.push(`${chain}: deploy block unknown (public node refused historical state); the first holders scan starts from block 0 and will be slow; set chains[0].fromBlock by hand if known`);

  const configChains = [
    { key: chain, ...(isSolana ? { vm: "solana" } : {}), origin: true, tokens: [{ address: origin.address, decimals: origin.decimals, status: "canonical" }] },
    ...Object.entries(included).map(([key, t]) => ({ key, ...(key === "solana" ? { vm: "solana" } : {}), tokens: [{ address: t.address, decimals: t.decimals, status: "canonical" }] })),
  ];
  const supplyTarget = wholeTokens(facts.totalSupplyRaw, facts.decimals);
  const inventory = buildInventory({
    project: { slug, config: { ticker, chains: configChains } },
    discovery,
    supplies: { [chain]: { [origin.address]: supplyTarget } },
    coingecko: coingecko?.id ?? null,
    now,
  });
  const rpcFailed = new Set((discovery?.chains ?? []).filter((d) => d.status === "rpc-error").map((d) => d.chain));
  for (const row of inventory.chains) {
    if (rpcFailed.has(row.chain) && row.status === "not-found") {
      row.status = "excluded";
      row.reason = `Public RPC failed during discovery, so ${row.chain} was not checked; re-run onboard.js where its RPC is reachable before going live.`;
      notes.push(`${row.chain}: not checked (public RPC error); re-run discovery`);
    } else if (row.status === "candidate") {
      row.status = "excluded";
      row.reason = EXCLUDE_REASON(row);
      notes.push(`${row.chain}: candidate copy found and left out (${row.tokens?.[0]?.address ?? "?"}); add with --include ${row.chain} after confirming its bridge`);
    }
  }

  const historyStart = overrides.historyStart ?? facts.deployDate ?? null;
  if (!historyStart && !isSolana) notes.push("history start unknown: pass --history-start, or rebuild-holders-history.yml uses its own default");
  const image = coingecko?.image ? { url: coingecko.image, path: `/tokens/${slug}.${imageExt(coingecko.image)}` } : null;
  if (!image) notes.push(`no CoinGecko image: add public/tokens/${slug}.<ext> and "image" by hand (check-go-live requires it)`);

  const argv = [
    "--slug", slug, "--name", name, "--ticker", ticker,
    ...chainSpecs.flatMap((c) => ["--chain", c]),
    "--supply-target", String(supplyTarget),
    ...(coingecko?.id ? ["--coingecko", coingecko.id] : []),
    ...(image ? ["--image", image.path] : []),
    ...(historyStart ? ["--history-start", historyStart] : []),
    ...(overrides.wallets ?? []).flatMap((w) => ["--wallet", w]),
  ];
  return { slug, name, ticker, vm: isSolana ? "solana" : "evm", supplyTarget, historyStart, image, inventory, argv, notes };
}
