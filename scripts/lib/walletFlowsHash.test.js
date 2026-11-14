import { describe, expect, it } from "vitest";
import { SWAP_TOPICS, buildVenueIndex } from "./walletFlows.js";
import { adoptLegacyState, legacyScanHash, scanHash, senderAddresses } from "./walletFlowsHash.js";
import { buildState, planChainScan, stateLogic, tokenConfigFingerprint } from "./walletFlowsState.js";
import { markSwaps, swapCandidates } from "./walletFlowsSwaps.js";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const BOT = "0x" + "c".repeat(40);
const DEST = "0x" + "d".repeat(40);
const OTHER = "0x" + "e".repeat(40);

const registry = (over = {}) => ({
  knownWallets: [{ address: A, label: "Treasury", entityClass: "team" }, { address: B, label: "Ops", entityClass: "team" }],
  botCluster: { addresses: [BOT], label: "Bots" },
  watchedSellers: [{ address: OTHER, label: "seller" }],
  ...over,
});
const chains = { ethereum: { tokens: { legacy: { address: "0x1", decimals: 2 } } } };
const logic = stateLogic({ swapTopics: SWAP_TOPICS, minCandidateTel: 1e6 });
const inputs = (over = {}) => ({
  logic,
  registry: registry(),
  cexWallets: [{ address: OTHER, label: "Kraken" }],
  dexAddresses: [DEST],
  upgradeContracts: ["0x" + "1".repeat(40)],
  bridgeAddresses: ["0x" + "2".repeat(40)],
  reconItems: [{ address: DEST, category: "dex" }],
  tokens: tokenConfigFingerprint(chains),
  ...over,
});
const newHash = (i) => scanHash({ logic: i.logic, registry: i.registry, tokens: i.tokens });

describe("scanHash", () => {
  it("does not change with labels: recon pairs, CEX, DEX, upgrade, bridges, registry labels or watched sellers", () => {
    const base = newHash(inputs());
    const labelOnly = inputs({
      cexWallets: [],
      dexAddresses: [],
      upgradeContracts: [],
      bridgeAddresses: [],
      reconItems: [{ address: B, category: "team" }],
      registry: registry({
        knownWallets: [{ address: A, label: "Renamed", entityClass: "escrow" }, { address: B, label: "Ops", entityClass: "team" }],
        watchedSellers: [],
      }),
    });
    expect(newHash(labelOnly)).toBe(base);
    // ...while the old format moved with every one of them (the bug this fixes).
    expect(legacyScanHash(labelOnly)).not.toBe(legacyScanHash(inputs()));
    expect(legacyScanHash(inputs({ reconItems: [] }))).not.toBe(legacyScanHash(inputs()));
  });

  it("changes with the sender set, tokens, logic version, swap topics or the swap candidate threshold", () => {
    const base = newHash(inputs());
    expect(newHash(inputs({ registry: registry({ knownWallets: [{ address: A }] }) }))).not.toBe(base);
    expect(newHash(inputs({ registry: registry({ botCluster: { addresses: [] } }) }))).not.toBe(base);
    expect(newHash(inputs({ tokens: tokenConfigFingerprint({ ethereum: { tokens: { legacy: { address: "0x9", decimals: 2 } } } }) }))).not.toBe(base);
    expect(newHash(inputs({ tokens: tokenConfigFingerprint({ ethereum: { tokens: { legacy: { address: "0x1", decimals: 18 } } } }) }))).not.toBe(base);
    expect(newHash(inputs({ logic: { ...logic, version: logic.version + 1 } }))).not.toBe(base);
    expect(newHash(inputs({ logic: stateLogic({ swapTopics: new Map([["0x1", "x"]]), minCandidateTel: 1e6 }) }))).not.toBe(base);
    expect(newHash(inputs({ logic: stateLogic({ swapTopics: SWAP_TOPICS, minCandidateTel: 5e5 }) }))).not.toBe(base);
  });

  it("sender set ignores order, case and duplicates", () => {
    expect(senderAddresses(registry({ knownWallets: [{ address: B }, { address: A.toUpperCase().replace("0X", "0x") }, { address: A }] }))).toEqual([A, B, BOT].sort());
  });
});

describe("adoptLegacyState (hash format migration)", () => {
  const i = inputs();
  const hash = newHash(i);
  const legacyHash = legacyScanHash(i);
  const stored = (configHash) => ({ ...buildState({ hash: configHash, chains: { ethereum: { cursor: 900, events: [] } } }) });

  it("adopts a state whose old-format hash matches the current inputs: re-stamped, no rescan", () => {
    const { state, adopted } = adoptLegacyState(stored(legacyHash), { hash, legacyHash });
    expect(adopted).toBe(true);
    expect(state.configHash).toBe(hash);
    expect(planChainScan({ state, chain: "ethereum", hash, start90: 100, head: 1000 }).full).toBe(false);
  });

  it("leaves a state whose old-format inputs changed (e.g. recon pairs) alone, so it rescans", () => {
    const moved = legacyScanHash(inputs({ reconItems: [] }));
    const { state, adopted } = adoptLegacyState(stored(legacyHash), { hash, legacyHash: moved });
    expect(adopted).toBe(false);
    expect(planChainScan({ state, chain: "ethereum", hash, start90: 100, head: 1000 })).toMatchObject({ full: true, reason: "registry or token config changed" });
  });

  it("is a no-op for a state already in the new format, a missing state or a changed sender set", () => {
    expect(adoptLegacyState(stored(hash), { hash, legacyHash }).adopted).toBe(false);
    expect(adoptLegacyState(null, { hash, legacyHash })).toEqual({ state: null, adopted: false });
    const changedSenders = inputs({ registry: registry({ knownWallets: [{ address: A }] }) });
    expect(adoptLegacyState(stored(legacyHash), { hash: newHash(changedSenders), legacyHash: legacyScanHash(changedSenders) }).adopted).toBe(false);
  });
});

describe("label changes handled incrementally through swapCandidates", () => {
  const ev = (to, extra = {}) => ({ chain: "ethereum", from: A, to, tel: 5e6, tx: `0x${to.slice(2, 6)}`, block: 10, logIndex: 0, ...extra });
  const index = (over = {}) => buildVenueIndex({ registry: registry(), cexWallets: [], dexAddresses: [], recon: { items: [] }, upgradeContracts: [], bridgeAddresses: [], ...over });
  const stored = [ev(DEST), ev(OTHER)];

  it("an address dropped from the DEX/CEX list becomes a candidate on the next run (no rescan, no hash change)", () => {
    const labelled = index({ dexAddresses: [DEST], cexWallets: [{ address: OTHER }] });
    expect(swapCandidates(stored, labelled, 1e6)).toEqual([]);
    const relabelled = index({ dexAddresses: [], cexWallets: [] });
    expect(swapCandidates(stored, relabelled, 1e6)).toHaveLength(2);
  });

  it("checks the newly unlabelled event once, and a newly labelled one is no longer checked", async () => {
    const events = [ev(DEST), ev(OTHER)];
    const fetched = [];
    const budget = { left: 10 };
    const fetchReceipt = async (tx) => (fetched.push(tx), { logs: [] });
    await markSwaps({ fetchReceipt, transfers: swapCandidates(events, index({ cexWallets: [{ address: OTHER }] }), 1e6), budget });
    expect(fetched).toHaveLength(1);
    expect(events.find((e) => e.to === DEST).swapped).toBe(false);
    expect(events.find((e) => e.to === OTHER).swapped).toBeUndefined();
    // Next run: OTHER lost its CEX label; DEST gained a DEX label. Only OTHER is checked; DEST keeps its verdict.
    fetched.length = 0;
    await markSwaps({ fetchReceipt, transfers: swapCandidates(events, index({ dexAddresses: [DEST] }), 1e6), budget });
    expect(fetched).toHaveLength(1);
    expect(events.find((e) => e.to === OTHER).swapped).toBe(false);
    expect(events.find((e) => e.to === DEST).swapped).toBe(false);
  });

  it("ignores bot senders and transfers under the threshold", () => {
    expect(swapCandidates([ev(DEST, { from: BOT }), ev(DEST, { tel: 1 })], index(), 1e6)).toEqual([]);
  });
});
