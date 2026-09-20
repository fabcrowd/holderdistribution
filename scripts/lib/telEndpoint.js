/**
 * First-hop TEL destinations that are pass-throughs. Classify the terminal
 * (custody, CEX, burn) rather than the relay EOA.
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Relay EOA → on-chain endpoint that actually holds or receives the TEL. */
export const TEL_RELAY_ENDPOINTS = {
  // TEL Treasury → this EOA → BitGo Custody (100% of the 2.5B Association SAFE leg)
  "0xb1714f449b85e8ba04ac9e9060928f6fdc0fd533": {
    endpoint: "0xbd02c51150a4ab6ce97b9de2025644594f3e75b8",
    label: "BitGo Custody",
  },
  // Settlement hub → this EOA → tagged KuCoin deposit wallets (lifetime out is 3 KuCoin addrs)
  "0x1128a473c43a9e0779113c4bf6d3aa186182bb41": {
    endpoint: "0x9ac5637d295fea4f51e086c329d791cc157b1c84",
    label: "KuCoin",
  },
  // Same in=out relay: window TEL out is a single hop to tagged KuCoin 32
  "0x5b34f69fe6da995f4c5e0de92adcbf02bfe6b4b0": {
    endpoint: "0x58edf78281334335effa23101bbe3371b6a36a51",
    label: "KuCoin",
  },
  // TEL Treasury → this EOA → tagged Uphold
  "0x00d328532f71b593510d712146fce346efe2667c": {
    endpoint: "0x1c727a55ea3c11b0ab7d3a361fe0f3c47ce6de5d",
    label: "Uphold",
  },
  // TEL Treasury → this EOA → Polygon ERC20 predicate (bridge)
  "0xacea3a74d6c0d288aea9886a3b78b0654def8c07": {
    endpoint: "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
    label: null,
  },
};

export const DEX_VENUES = new Map(
  [
    ["0x9008d19f58aabd9ed0d60971565aa8510560ab41", "cow"],
    ["0x1111111254eeb25477c68e45fd058a5132791055", "1inch"],
    ["0x1380f2f57553ada04b31ee7b1e039e496939db3d", "1inch"],
    ["0xc47a52645b31c66b94158da5e570601c6d375a4b", "kyber"],
    ["0xc47a52645b9a684ea65c87e60fc60397541d9e0e", "kyber"],
    ["0xdef1abe32c034e558dd035793d159bd7fd3380a0", "0x"],
  ].map(([a, v]) => [a.toLowerCase(), v]),
);

export const BRIDGE_INFRA = new Set(
  [
    "0x3154cf16ccdb4c6d922629664174b904d80f2c35",
    "0x8484ef722627bf18ca5843dde598ab10a259f2aa",
    "0x401f6c983ea34274ec46f84d70b31c151321188b",
    "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
    "0x707856c0089fd59d9e686a47784d5dad7c0784c4",
    "0xacea3a74e0f7b7935e08646748748852d9845527",
  ].map((a) => a.toLowerCase()),
);

export const PROCEED_HOPS = new Set(
  [
    "0x10f7835f827d6cf035115e10c50a853d7fb2d2ec",
    "0x9008d19f58aabd9ed0d60971565aa8510560ab41",
    "0x11cb903d2f797d4410fd5e65ba9aa641a0741fc3",
    "0xe71e5bb31d76be3a4a840e1781a4b49645079105",
  ].map((a) => a.toLowerCase()),
);

export const REWARD_CONTRACTS = new Set(
  [
    "0xe533911f00f1c3b58bb8d821131c9b6e2452fc27",
    "0x7feb8febddb66189417f732b4221a52e23b926c4",
    "0x8f702676830ddca2801a4a7cdb971cde4df697ae",
    "0x79e5a6ffe2e6ba053a80e1b199c4f328938f40ca",
  ].map((a) => a.toLowerCase()),
);

const norm = (to) => String(to ?? "").trim().toLowerCase();

/**
 * @param {string} to
 * @returns {{ endpoint: string, hop: "burn" | "relay" | "direct", label: string | null }}
 */
export function resolveTelEndpoint(to) {
  const addr = norm(to);
  if (addr === ZERO_ADDRESS) {
    return { endpoint: addr, hop: "burn", label: "Burn" };
  }
  const relay = TEL_RELAY_ENDPOINTS[addr];
  if (relay) {
    return { endpoint: relay.endpoint, hop: "relay", label: relay.label };
  }
  return { endpoint: addr, hop: "direct", label: null };
}

function nameFor(addr, labelMap, cexMap) {
  return labelMap.get(addr)?.name ?? cexMap.get(addr)?.label ?? null;
}

/**
 * Classify `to` itself (no relay hop).
 * @param {string} to
 * @param {Map<string, { name: string, category: string }>} labelMap
 * @param {Map<string, { label: string, walletName?: string }>} cexMap
 * @param {Set<string>} controlledSet
 */
export function classifyFirstHop(to, labelMap, cexMap, controlledSet) {
  const addr = norm(to);
  if (!addr) return { classification: "unlabeled", venue: null, toLabel: null };
  if (DEX_VENUES.has(addr)) {
    return { classification: "dex_venue", venue: DEX_VENUES.get(addr), toLabel: null };
  }
  if (BRIDGE_INFRA.has(addr)) return { classification: "bridge", venue: null, toLabel: null };
  if (PROCEED_HOPS.has(addr)) return { classification: "infrastructure", venue: null, toLabel: null };
  if (REWARD_CONTRACTS.has(addr)) return { classification: "reward_contract", venue: null, toLabel: null };
  if (controlledSet.has(addr)) {
    return { classification: "internal_safe", venue: null, toLabel: nameFor(addr, labelMap, cexMap) };
  }
  const label = labelMap.get(addr);
  if (label?.category === "escrow") {
    return { classification: "custody", venue: null, toLabel: label.name };
  }
  if (label?.category === "holdings") {
    return { classification: "holdings", venue: null, toLabel: label.name };
  }
  if (label?.category === "council" || label?.category === "treasury") {
    return { classification: "internal_safe", venue: null, toLabel: label.name };
  }
  const cex = cexMap.get(addr);
  if (cex) return { classification: "cex", venue: cex.label, toLabel: cex.label };
  return { classification: "unlabeled", venue: null, toLabel: null };
}

/**
 * Classify the economic endpoint, not a pass-through relay.
 * @param {string} to
 * @param {Map<string, { name: string, category: string }>} labelMap
 * @param {Map<string, { label: string, walletName?: string }>} cexMap
 * @param {Set<string>} controlledSet
 */
export function classifyDestination(to, labelMap, cexMap, controlledSet) {
  const addr = norm(to);
  const resolved = resolveTelEndpoint(addr);
  if (resolved.hop === "burn") {
    return { classification: "burn", venue: null, toLabel: "Burn", endpoint: addr };
  }
  const hit = classifyFirstHop(resolved.endpoint, labelMap, cexMap, controlledSet);
  return {
    classification: hit.classification,
    venue: hit.venue,
    toLabel: resolved.label ?? hit.toLabel,
    endpoint: resolved.endpoint,
  };
}

/**
 * First hop that is actually a bridge. Value is either a dest-chain landing
 * (Association wallet already scanned on that chain) or an off-ledger terminal
 * when the dest chain is not in the ledger (Base).
 *
 * Keyed by the *immediate* recipient of the Association outflow — the relay or
 * the bridge contract — so two Treasury legs that both end at the Polygon
 * predicate still resolve to different landings.
 */
export const BRIDGE_FOLLOW = {
  // Treasury → this EOA → predicate → mint to this EOA on Polygon → TAO Safe
  "0x707856c0089fd59d9e686a47784d5dad7c0784c4": {
    destChain: "polygon",
    landing: "0xf4bc288d616c4f57071a57f5a4050b5e516fe7e5",
    label: "TAO Safe",
  },
  // Treasury → this EOA → predicate → mint to this EOA → TELx Council
  "0xacea3a74d6c0d288aea9886a3b78b0654def8c07": {
    destChain: "polygon",
    landing: "0x583d596b0a79c0e83c87851ea9fb1a91e80290b2",
    label: "TELx Council",
  },
  // Direct deposit to Polygon ERC20 predicate: same-address mint on Polygon
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf": {
    destChain: "polygon",
    sameAddress: true,
  },
  // TA Sale → Base L1 Standard Bridge → mint to TA Sale on Base → rewards
  "0x3154cf16ccdb4c6d922629664174b904d80f2c35": {
    destChain: "base",
    onwardByFrom: {
      "0x11cb903d2f797d4410fd5e65ba9aa641a0741fc3": {
        endpoint: "0xe3a465e1460e9987c772c36b91020946bc60af52",
        classification: "reward_contract",
        label: "TELx rewards (Base)",
      },
    },
  },
};

function followBridge(from, hopAddr, labelMap, cexMap, controlledSet) {
  const spec = BRIDGE_FOLLOW[hopAddr];
  if (!spec) return null;
  const sender = norm(from);
  const onward = spec.onwardByFrom?.[sender];
  if (onward) {
    return {
      classification: onward.classification,
      venue: null,
      toLabel: onward.label,
      endpoint: onward.endpoint,
      endpointChain: spec.destChain,
    };
  }
  const landing = spec.sameAddress ? sender : spec.landing;
  if (!landing) return null;
  const hit = classifyFirstHop(landing, labelMap, cexMap, controlledSet);
  const landingLabel = spec.label ?? hit.toLabel ?? nameFor(landing, labelMap, cexMap);
  if (hit.classification === "internal_safe" || controlledSet.has(landing)) {
    return {
      classification: "chain_transport",
      venue: null,
      toLabel: landingLabel,
      endpoint: landing,
      endpointChain: spec.destChain,
    };
  }
  return { ...hit, endpoint: landing, endpointChain: spec.destChain };
}

/**
 * Classify the economic endpoint, not a pass-through relay or bridge hop.
 * Unlabeled outflows from TELx reward contracts are reward claimants.
 * @param {string} from
 * @param {string} to
 */
export function classifyTelMovement(from, to, labelMap, cexMap, controlledSet) {
  const addr = norm(to);
  const bridged = followBridge(from, addr, labelMap, cexMap, controlledSet);
  if (bridged) return bridged;
  const hit = classifyDestination(to, labelMap, cexMap, controlledSet);
  if (hit.classification === "bridge") {
    const viaEndpoint = followBridge(from, hit.endpoint, labelMap, cexMap, controlledSet);
    if (viaEndpoint) return viaEndpoint;
  }
  if (hit.classification === "unlabeled" && REWARD_CONTRACTS.has(norm(from))) {
    return { ...hit, classification: "reward_payout", toLabel: hit.toLabel ?? "Reward claimant" };
  }
  return hit;
}
