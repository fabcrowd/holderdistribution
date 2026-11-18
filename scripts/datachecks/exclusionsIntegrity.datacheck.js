// Data checks (npm run check:data): TEL's exclusions against the live snapshot and the
// hand-kept data/unallocated-classification.json. Moved unchanged from scripts/lib/exclusionsIntegrity.test.js.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const MATERIALITY_TEL = 100_000_000;

describe.runIf(inScope("tel"))("exclusions integrity", () => {
  const exclusions = JSON.parse(read("config/exclusions.json"));
  const classification = JSON.parse(read("data/unallocated-classification.json"));
  const holders = JSON.parse(read("public/data/tel-holders.json"));

  it("keeps unallocated-classification categories in sync with exclusions labels", () => {
    for (const entry of classification.entries ?? []) {
      const addr = entry.address.toLowerCase();
      const label = exclusions.labels?.[addr];
      expect(label, `classification address missing from exclusions: ${addr}`).toBeTruthy();
      expect(label.category, `category drift on ${addr}`).toBe(entry.category);
    }
  });

  it("labels every excluded wallet above 100M TEL (or lists it as unresolved)", () => {
    // Failure mode: large balances sit on exclusions.addresses with no category,
    // so they vanish from retail without appearing in any supply bucket. Retail
    // whales over 100M are allowed to stay unlabelled.
    const exclusionSet = new Set(exclusions.addresses.map((a) => a.toLowerCase()));
    const labelled = new Set(Object.keys(exclusions.labels ?? {}).map((a) => a.toLowerCase()));
    const unresolved = new Set(
      (classification.unresolved ?? []).map((u) => (typeof u === "string" ? u : u.address).toLowerCase()),
    );
    const offenders = [];
    for (const wallet of holders.wallets ?? []) {
      const addr = (wallet.address ?? "").toLowerCase();
      const bal = Number(wallet.total_telcoin_balance ?? wallet.total_balance ?? wallet.totalBalance ?? 0);
      if (!addr || !Number.isFinite(bal) || bal <= MATERIALITY_TEL) continue;
      if (!exclusionSet.has(addr)) continue;
      if (!labelled.has(addr) && !unresolved.has(addr)) offenders.push(`${addr} (${bal})`);
    }
    expect(offenders, `>100M excluded TEL must be labelled or unresolved: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("never lets nonCirculatingOverride exceed the address's real on-chain balance", () => {
    // nonCirculatingOverride (scripts/lib/reconcileSupply.js) records TEL
    // contractually committed elsewhere (e.g. a SAFE's return-to-treasury
    // clause) — a point-in-time fact. If the wallet's real balance ever drops
    // below the committed amount (the TEL actually moved), the override goes
    // stale and must be re-traced by hand, not silently over-subtracted from
    // circulating. This is the guard that catches that drift against the
    // live snapshot, not a synthetic fixture.
    const balanceByAddress = new Map();
    for (const wallet of holders.wallets ?? []) {
      const addr = (wallet.address ?? "").toLowerCase();
      if (addr) {
        balanceByAddress.set(
          addr,
          Number(wallet.total_telcoin_balance ?? wallet.total_balance ?? wallet.totalBalance ?? 0),
        );
      }
    }
    const offenders = [];
    for (const [address, meta] of Object.entries(exclusions.labels ?? {})) {
      const override = Number(meta?.nonCirculatingOverride) || 0;
      if (override <= 0) continue;
      const balance = balanceByAddress.get(address.toLowerCase()) ?? 0;
      if (override > balance) {
        offenders.push(`${address} (${meta.name}): override ${override} > real balance ${balance}`);
      }
    }
    expect(offenders, `nonCirculatingOverride has drifted stale: ${offenders.join(", ")}`).toEqual([]);
  });
});
