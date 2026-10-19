import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exclusions = JSON.parse(read("config/exclusions.json"));
const classification = JSON.parse(read("data/unallocated-classification.json"));
const cexWallets = JSON.parse(read("config/cex-wallets.json"));
const holders = JSON.parse(read("public/data/tel-holders.json"));

const VALID_CATEGORIES = new Set([
  "bridge-lock",
  "staking-contract",
  "escrow",
  "treasury",
  "council",
  "cex",
  "dex",
  "burn",
  "safe-cluster",
  "holdings",
  "whale-unattributed",
  "retail-whale",
  "dormant-whale",
]);

const VALID_EVIDENCE_TIERS = new Set([
  "explorer-label",
  "ownership-scrutiny",
  "counterparty-inference",
  "signer-graph",
  "contract-analysis",
  "funding-trace",
  "on-chain-pattern",
  "owner-supplied",
  "dune-3761086",
]);

const VALID_CONFIDENCE = new Set(["confirmed", "high", "medium"]);

const MATERIALITY_TEL = 100_000_000;

// The supply constant that was hardcoded in three separate places, uncited and
// ~7.4B below the real total, making every "% of supply" figure too large.
const WRONG_SUPPLY_CONSTANTS = ["92_577_234_366", "92577234366"];

// Walks .html too, not just source files. The wrong supply constant survived
// this guard for months inside wallet_tracker/walletupdate.html — a file that
// was both in a skipped directory AND of an unscanned extension. The directory
// is gone now; closing the extension gap keeps the guard from being dodged the
// same way again.
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "public"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|html)$/.test(entry.name) && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
};

describe("exclusions integrity", () => {
  it("keeps config/exclusions.json parseable with unique, normalised addresses", () => {
    const addrs = exclusions.addresses;
    expect(Array.isArray(addrs)).toBe(true);
    for (const a of addrs) expect(a).toMatch(/^0x[a-f0-9]{40}$/);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it("only uses known label categories, and labels only known addresses", () => {
    const addrSet = new Set(exclusions.addresses.map((a) => a.toLowerCase()));
    for (const [address, meta] of Object.entries(exclusions.labels ?? {})) {
      expect(VALID_CATEGORIES, `unknown category on ${address}`).toContain(meta.category);
      expect(addrSet, `labelled address not in addresses[]: ${address}`).toContain(address.toLowerCase());
      expect(meta.name, `label for ${address} needs a name`).toBeTruthy();
    }
  });

  it("requires evidenceTier + confidence on every label", () => {
    for (const [address, meta] of Object.entries(exclusions.labels ?? {})) {
      expect(VALID_EVIDENCE_TIERS, `bad evidenceTier on ${address}: ${meta.evidenceTier}`).toContain(
        meta.evidenceTier,
      );
      expect(VALID_CONFIDENCE, `bad confidence on ${address}: ${meta.confidence}`).toContain(meta.confidence);
    }
  });

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

  it("keeps every cex-labelled address in config/cex-wallets.json", () => {
    // CEX Balance is driven by cexSet, not by exclusion category alone.
    const cexSet = new Set((cexWallets.wallets ?? []).map((w) => w.address.toLowerCase()));
    const missing = [];
    for (const [address, meta] of Object.entries(exclusions.labels ?? {})) {
      if (meta.category !== "cex") continue;
      if (!cexSet.has(address.toLowerCase())) missing.push(address);
    }
    expect(missing, `cex labels must be in cex-wallets.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("labels every bridge-lock address, since bridges must never reach a supply figure", () => {
    // The original bug: a 37B Polygon bridge sat unlabelled in a flat address
    // list, so summing chains double-counted it into a 142B "total supply" and
    // it ranked as the largest holder. computeSupplyTotals keys off this label.
    const bridges = Object.entries(exclusions.labels ?? {}).filter(([, m]) => m.category === "bridge-lock");
    expect(bridges.length).toBeGreaterThan(0);
  });

  it("does not reintroduce the wrong hardcoded supply constant anywhere in src/ or scripts/", () => {
    // Matches an ASSIGNMENT of the value, not a mention. The pipeline scripts
    // reference the old number in comments explaining why supply is now derived;
    // documenting the bug is the opposite of reintroducing it.
    const assigned = new RegExp(`=\\s*(${WRONG_SUPPLY_CONSTANTS.join("|")})\\b`);
    const offenders = [];
    for (const file of [...walk(path.join(root, "src")), ...walk(path.join(root, "scripts"))]) {
      if (assigned.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(root, file));
    }
    expect(offenders, `supply must be derived, not hardcoded: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps config/exclusions.json the single source of truth for exclusions", () => {
    // Guards the three-divergent-copies hazard: config/exclusions.json (157),
    // a hardcoded 119-address list in src/lib/holderAnalysis.ts, and a malformed
    // third copy under wallet_tracker/. A second in-code list silently drifts.
    //
    // Keyed on OVERLAP with the real exclusion set, not raw address count —
    // pages legitimately hold token/pair addresses (Markets.tsx has 24, of which
    // 1 overlaps). A duplicated exclusion list would overlap heavily.
    const exclusionSet = new Set(exclusions.addresses.map((a) => a.toLowerCase()));
    const offenders = [];
    // Forensic write-ups are narrative prose that cites the wallets they discuss
    // by address; they are not a second exclusion list.
    const PROSE_ALLOWLIST = new Set(["src/data/forensicsWriteups.ts"]);
    for (const file of walk(path.join(root, "src"))) {
      if (PROSE_ALLOWLIST.has(path.relative(root, file).split(path.sep).join("/"))) continue;
      const found = new Set(
        (fs.readFileSync(file, "utf8").match(/0x[a-fA-F0-9]{40}/g) ?? []).map((a) => a.toLowerCase())
      );
      const overlap = [...found].filter((a) => exclusionSet.has(a)).length;
      if (overlap > 5) offenders.push(`${path.relative(root, file)} (${overlap} shared addresses)`);
    }
    expect(offenders, `exclusion lists belong only in config/exclusions.json: ${offenders.join(", ")}`).toEqual([]);
  });

  it("forbids non-empty chains.*.addresses until per-chain scoping is real", () => {
    // Every consumer except pull-holders-rpc.js flattens chain exclusions into
    // the global set. A non-empty chains.*.addresses entry would therefore look
    // chain-scoped in config but apply globally — fail loud until real scoping exists.
    const offenders = [];
    for (const [chain, info] of Object.entries(exclusions.chains ?? {})) {
      const addrs = info?.addresses ?? [];
      if (addrs.length > 0) offenders.push(`${chain} (${addrs.length})`);
    }
    expect(offenders, `chains.*.addresses must stay empty: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps every dex-contracts pool and router in exclusions.addresses with a dex label", () => {
    const dex = JSON.parse(read("config/dex-contracts.json"));
    const addrSet = new Set(exclusions.addresses.map((a) => a.toLowerCase()));
    const entries = [
      ...(dex.pools ?? []).map((p) => ({ ...p, kind: "pool" })),
      ...(dex.routers ?? []).map((r) => ({ ...r, kind: "router" })),
    ];
    for (const entry of entries) {
      const a = entry.address.toLowerCase();
      expect(addrSet, `${entry.kind} missing from exclusions.addresses: ${a}`).toContain(a);
      expect(exclusions.labels?.[a]?.category, `${entry.kind} ${a} needs category:dex`).toBe("dex");
    }
  });
});
