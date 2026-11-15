import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_FAIL_BYTES,
  SNAPSHOT_WARN_BYTES,
  checkSnapshotSize,
  hydrateChainHolders,
  resyncSnapshot,
  serializeSnapshot,
  serializeVerified,
  snapshotLayout,
} from "./snapshotFormat.js";

const MIB = 1024 * 1024;

const chainEntry = (key, holders) => ({
  key,
  name: key,
  metrics: { holderCount: holders.length, totalBalance: 0, excluded: { count: 1, balance: 900 } },
  holders,
});

// Real shape: wallets[] sorted by total desc, `<k>_balance` + total_telcoin_balance; the
// chain's holders[] is the same rows minus scan-time exclusions/mega, in the same order.
const singleChain = () => ({
  generatedAt: "2026-11-14T00:00:00.000Z",
  thresholds: { retail: 1000 },
  chains: {
    hedera: chainEntry("hedera", [
      { address: "0.0.1", balance: 300 },
      { address: "0.0.3", balance: 100 },
      { address: "0.0.4", balance: 100 },
    ]),
  },
  combined: { holderCount: 3 },
  wallets: [
    { address: "0.0.9", hedera_balance: 900, total_telcoin_balance: 900 },
    { address: "0.0.1", hedera_balance: 300, total_telcoin_balance: 300 },
    { address: "0.0.3", hedera_balance: 100, total_telcoin_balance: 100 },
    { address: "0.0.4", hedera_balance: 100, total_telcoin_balance: 100 },
    { address: "0.0.5", hedera_balance: 0, total_telcoin_balance: 0 },
  ],
  chainOrder: ["hedera"],
  source: { type: "rpc" },
  asOf: { date: "2026-11-13" },
});

const twoChain = () => ({
  chains: {
    a: chainEntry("a", [{ address: "x", balance: 1 }]),
    b: chainEntry("b", [{ address: "x", balance: 2 }]),
  },
  wallets: [{ address: "x", a_balance: 1, b_balance: 2, total_telcoin_balance: 3 }],
});

describe("serializeSnapshot", () => {
  it("writes a multi-chain snapshot exactly as the legacy pretty printer did", () => {
    const o = twoChain();
    expect(snapshotLayout(o)).toBe("legacy");
    expect(serializeSnapshot(o)).toBe(`${JSON.stringify(o, null, 2)}\n`);
  });

  it("writes a single-chain snapshot slim and round-trips the holders", () => {
    const o = singleChain();
    expect(snapshotLayout(o)).toBe("slim-v1");
    const parsed = JSON.parse(serializeSnapshot(o));
    expect(parsed.layout).toBe("slim-v1");
    expect(parsed.chains.hedera.holders).toBeUndefined();
    expect(parsed.chains.hedera.holdersOmitted).toEqual(["0.0.9"]);
    expect(parsed.wallets).toEqual(o.wallets);
    expect(hydrateChainHolders(parsed).chains.hedera.holders).toEqual(o.chains.hedera.holders);
  });

  it("writes one wallet row per line", () => {
    const o = singleChain();
    const text = serializeSnapshot(o);
    const start = text.indexOf('"wallets": [\n') + '"wallets": [\n'.length;
    const end = text.indexOf("\n]", start);
    const rows = text.slice(start, end).split("\n");
    expect(rows).toHaveLength(o.wallets.length);
    rows.forEach((row, i) => expect(JSON.parse(row.replace(/,$/, ""))).toEqual(o.wallets[i]));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("handles an empty wallets list", () => {
    const o = singleChain();
    o.wallets = [];
    o.chains.hedera.holders = [];
    o.chains.hedera.metrics.holderCount = 0;
    expect(JSON.parse(serializeSnapshot(o)).wallets).toEqual([]);
  });

  it("is stable when re-serializing a slim file", () => {
    const once = serializeSnapshot(singleChain());
    expect(serializeSnapshot(JSON.parse(once))).toBe(once);
  });

  it("does not mutate its input", () => {
    const o = singleChain();
    const before = JSON.stringify(o);
    serializeSnapshot(o);
    expect(JSON.stringify(o)).toBe(before);
  });
});

describe("hydrateChainHolders", () => {
  it("leaves an old-layout snapshot as it is", () => {
    const o = twoChain();
    const before = JSON.stringify(o);
    const out = hydrateChainHolders(o);
    expect(out.chains.a.holders).toBe(o.chains.a.holders);
    expect(JSON.stringify(o)).toBe(before);
    const legacySingle = singleChain();
    expect(hydrateChainHolders(legacySingle).chains.hedera.holders).toBe(legacySingle.chains.hedera.holders);
  });

  it("does not mutate a slim input", () => {
    const parsed = JSON.parse(serializeSnapshot(singleChain()));
    const before = JSON.stringify(parsed);
    hydrateChainHolders(parsed);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("passes null through", () => {
    expect(hydrateChainHolders(null)).toBeNull();
  });

  it("throws when the rebuilt length differs from metrics.holderCount", () => {
    const parsed = JSON.parse(serializeSnapshot(singleChain()));
    parsed.chains.hedera.metrics.holderCount = 4;
    expect(() => hydrateChainHolders(parsed)).toThrow(/hedera.*3.*4/s);
  });
});

describe("checkSnapshotSize", () => {
  it("is ok just under the warn size", () => {
    expect(checkSnapshotSize(SNAPSHOT_WARN_BYTES - 1, "a.json").level).toBe("ok");
  });

  it("warns at the warn size and names the file and MiB", () => {
    const r = checkSnapshotSize(SNAPSHOT_WARN_BYTES, "public/data/x/tel-holders.json");
    expect(r.level).toBe("warn");
    expect(r.message).toContain("public/data/x/tel-holders.json");
    expect(r.message).toContain("50.00 MiB");
  });

  it("fails at the fail size and says the file cannot be pushed", () => {
    const r = checkSnapshotSize(SNAPSHOT_FAIL_BYTES, "tel-holders.json");
    expect(r.level).toBe("fail");
    expect(r.message).toContain("tel-holders.json");
    expect(r.message).toContain("95.00 MiB");
    expect(r.message).toContain("100 MiB");
    expect(r.message).toMatch(/cannot be pushed to GitHub/);
    expect(r.message).toMatch(/sharded/);
    expect(r.message).not.toMatch(/balance floor/);
  });

  it("uses MiB constants", () => {
    expect(SNAPSHOT_WARN_BYTES).toBe(50 * MIB);
    expect(SNAPSHOT_FAIL_BYTES).toBe(95 * MIB);
  });
});

describe("serializeVerified", () => {
  it("returns the slim text for a consistent snapshot", () => {
    const o = singleChain();
    expect(serializeVerified(o, "f.json")).toBe(serializeSnapshot(o));
  });

  it("throws when holders are not a subset of wallets", () => {
    const o = singleChain();
    o.chains.hedera.holders[0] = { address: "0.0.1", balance: 301 };
    expect(() => serializeVerified(o, "f.json")).toThrow(/round trip/);
  });

  it("leaves a multi-chain snapshot in the legacy layout", () => {
    const o = twoChain();
    expect(serializeVerified(o, "f.json")).toBe(`${JSON.stringify(o, null, 2)}\n`);
  });
});

describe("hydrateChainHolders without metrics.holderCount", () => {
  // The holderCount check is skipped when the metric is absent.
  it("still rebuilds (the count check is skipped when the metric is absent)", () => {
    const parsed = JSON.parse(serializeSnapshot(singleChain()));
    delete parsed.chains.hedera.metrics.holderCount;
    expect(hydrateChainHolders(parsed).chains.hedera.holders).toEqual(singleChain().chains.hedera.holders);
  });
});

describe("resyncSnapshot", () => {
  const RETAIL = 150;
  const none = new Set();

  it("keeps a slim single-chain file slim and records a newly excluded holder", () => {
    const slim = JSON.parse(serializeSnapshot(singleChain()));
    const { snapshot, removed, added } = resyncSnapshot(hydrateChainHolders(slim), new Set(["0.0.9", "0.0.3"]), RETAIL);
    expect([added, removed]).toEqual([0, 1]);
    const parsed = JSON.parse(serializeVerified(snapshot, "f.json"));
    expect(parsed.layout).toBe("slim-v1");
    expect(parsed.chains.hedera.holders).toBeUndefined();
    expect(parsed.chains.hedera.holdersOmitted).toEqual(["0.0.9", "0.0.3"]);
    const hydrated = hydrateChainHolders(parsed);
    expect(hydrated.chains.hedera.holders).toEqual([
      { address: "0.0.1", balance: 300 },
      { address: "0.0.4", balance: 100 },
    ]);
    expect(parsed.chains.hedera.metrics.holderCount).toBe(2);
    expect(parsed.chains.hedera.metrics.totalBalance).toBe(400);
    expect(parsed.chains.hedera.metrics.retail.count).toBe(1);
    expect(parsed.combined.holderCount).toBe(2);
  });

  it("is byte-stable on a slim file when the exclusion set is unchanged", () => {
    const excluded = new Set(["0.0.9"]);
    const pass = (text) => serializeVerified(resyncSnapshot(hydrateChainHolders(JSON.parse(text)), excluded, RETAIL).snapshot, "f.json");
    const first = pass(serializeSnapshot(singleChain()));
    expect(JSON.parse(first).layout).toBe("slim-v1");
    expect(pass(first)).toBe(first);
  });

  it("orders a re-added tied wallet by wallets[] position so a slim file still round trips", () => {
    const o = singleChain();
    o.wallets = [
      { address: "0.0.1", hedera_balance: 300, total_telcoin_balance: 300 },
      { address: "0.0.2", hedera_balance: 100, total_telcoin_balance: 100 },
      { address: "0.0.3", hedera_balance: 100, total_telcoin_balance: 100 },
    ];
    o.chains.hedera.holders = [
      { address: "0.0.1", balance: 300 },
      { address: "0.0.3", balance: 100 },
    ];
    o.chains.hedera.metrics.holderCount = 2;
    const slim = JSON.parse(serializeSnapshot(o));
    const { snapshot, added } = resyncSnapshot(hydrateChainHolders(slim), none, RETAIL);
    expect(added).toBe(1);
    const parsed = JSON.parse(serializeVerified(snapshot, "f.json"));
    expect(parsed.layout).toBe("slim-v1");
    expect(hydrateChainHolders(parsed).chains.hedera.holders.map((h) => h.address)).toEqual(["0.0.1", "0.0.2", "0.0.3"]);
  });

  it("writes legacy bytes for a two-chain snapshot", () => {
    const o = twoChain();
    const { snapshot } = resyncSnapshot(hydrateChainHolders(o), none, RETAIL);
    expect(serializeVerified(snapshot, "f.json")).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
    expect(JSON.parse(serializeVerified(snapshot, "f.json")).layout).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const o = singleChain();
    const before = JSON.stringify(o);
    resyncSnapshot(o, new Set(["0.0.3"]), RETAIL);
    expect(JSON.stringify(o)).toBe(before);
  });
});
