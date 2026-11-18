import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSolanaTierDays } from "./solana/flowFeeds.js";
import { buildHederaTierDays } from "./hedera/flowConfig.js";
import { decodeRows, encodeRows, parseDateFile, resolveCounterpartyTiers, serializeDateFile } from "./tierCounterpartyDays.js";

let root;
let dir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tier-cp-days-"));
  dir = path.join(root, "data", "demo", "tier-counterparty-days");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const BASIS = { kind: "solana", snapshot: "public/data/demo/tel-holders.json", chains: ["sol", "sol2"], rowsRule: 1 };
const thresholdTier = (min) => (v) => (v >= min ? "big" : v > 0 ? "small" : null);
const dateFile = (date) => path.join(dir, `${date}.json`);
const readDate = (date) => JSON.parse(fs.readFileSync(dateFile(date), "utf8"));
const fileStats = () => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, { text: fs.readFileSync(path.join(dir, f), "utf8"), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }]));

// Snapshots: date -> chain -> rows. "W" holds on both chains (summed); "X" is never a holder.
const SNAPSHOTS = {
  "2026-11-01": { sol: [["A", 5], ["W", 60]], sol2: [["W", 50], ["B", 0]] },
  "2026-11-03": { sol: [["A", 500], ["C", 7], ["W", 1]], sol2: [] },
};
const versionsOf = (snaps, tag = "v1") => new Map(Object.keys(snaps).map((d) => [d, `${tag}-${d}`]));

const flowStore = (days) => ({
  chains: {
    sol: {
      days: Object.fromEntries(Object.entries(days).map(([date, owners]) => [
        date, { counterparties: Object.fromEntries(owners.map((o, i) => [`${i % 2 ? "cexIn" : "dexOut"}|venue|${o}`, String(1000 * (i + 1))])) },
      ])),
    },
  },
});

/** A readRows that serves the fixtures and records each read. */
const reader = (snaps) => {
  const reads = [];
  return {
    reads,
    readRows: function* (snapDate, version) {
      reads.push(`${snapDate}@${version}`);
      for (const rows of Object.values(snaps[snapDate])) for (const [address, balance] of rows) yield { address, balance };
    },
  };
};

/** The generator's original rule: one full holder->tier Map per snapshot (sum across chains, exclusions first). */
const referenceTierAt = (snaps, excl, tierOf) => (date) => {
  const best = Object.keys(snaps).sort().filter((d) => d <= date).pop();
  if (!best) return new Map();
  const bal = new Map();
  for (const rows of Object.values(snaps[best])) for (const [a, v] of rows) if (a && !excl.has(a)) bal.set(a, (bal.get(a) ?? 0) + v);
  const tiers = new Map();
  for (const [a, v] of bal) { const t = tierOf(v); if (t) tiers.set(a, t); }
  return tiers;
};

const solanaTierOf = (excl, tierOf) => (owner, rows) => (rows.length === 0 || excl.has(owner) ? null : tierOf(rows.reduce((s, v) => s + v, 0)));
const build = (store, snaps, tierAt) => buildSolanaTierDays(store, { decimals: 0, firstSnapshotDate: Object.keys(snaps).sort()[0], tierAt });
const reference = (store, snaps = SNAPSHOTS, excl = new Set(), tierOf = thresholdTier(100)) => build(store, snaps, referenceTierAt(snaps, excl, tierOf));

const run = async ({ store, snaps = SNAPSHOTS, versions = versionsOf(snaps), excl = new Set(), tierOf = thresholdTier(100), basis = BASIS }) => {
  const r = reader(snaps);
  const logs = [];
  const res = await resolveCounterpartyTiers({
    dir, basis, store, snapDates: Object.keys(snaps).sort(), versions,
    readRows: r.readRows, tierOf: solanaTierOf(excl, tierOf), log: (l) => logs.push(l),
  });
  return { ...res, reads: r.reads, logs, days: build(store, snaps, res.tierAt) };
};

const STORE = flowStore({ "2026-10-31": ["A"], "2026-11-01": ["A", "W", "X"], "2026-11-02": ["B", "W"], "2026-11-03": ["A", "C", "W"] });

describe("resolveCounterpartyTiers", () => {
  it("matches the full-snapshot build, one compact file per date; a second run reads and rewrites nothing", async () => {
    const first = await run({ store: STORE });
    expect(first.days).toEqual(reference(STORE));
    expect(first.reads).toEqual(["2026-11-01@v1-2026-11-01", "2026-11-03@v1-2026-11-03"]);
    expect(first.logs.at(-1)).toBe("Tier counterparty days: snapshots read: 2 of 2; files written: 2, removed: 0.");
    expect(fs.readdirSync(dir).sort()).toEqual(["2026-11-01.json", "2026-11-03.json"]);
    expect(fs.readFileSync(dateFile("2026-11-01"), "utf8").split("\n")).toHaveLength(2);
    const before = fileStats();

    const second = await run({ store: STORE });
    expect(second.reads).toEqual([]);
    expect(second.logs).toEqual(["Tier counterparty days: snapshots read: 0 of 2; files written: 0, removed: 0."]);
    expect(second.days).toEqual(first.days);
    expect(fileStats()).toEqual(before);
  });

  it("stores balances with an explicit not-a-holder marker, summed rows kept in order", async () => {
    await run({ store: STORE });
    expect(readDate("2026-11-01")).toEqual({ schema: 1, basis: BASIS, version: "v1-2026-11-01", balances: { A: 5, B: 0, W: [60, 50], X: null } });
  });

  it("reads only the old day's snapshot for a new counterparty on that day, and leaves the other file untouched", async () => {
    await run({ store: STORE });
    const untouched = fileStats()["2026-11-03.json"];
    const grown = flowStore({ "2026-10-31": ["A"], "2026-11-01": ["A", "W", "X"], "2026-11-02": ["B", "W", "C"], "2026-11-03": ["A", "C", "W"] });
    const next = await run({ store: grown });
    expect(next.reads).toEqual(["2026-11-01@v1-2026-11-01"]);
    expect(next.logs[0]).toBe("Tier counterparty days: read snapshot 2026-11-01 (v1-2026-): 1 new counterparties.");
    expect(next.days).toEqual(reference(grown));
    expect(fileStats()["2026-11-03.json"]).toEqual(untouched);
  });

  it("rebuilds only the date whose version changed (a same-day rerun)", async () => {
    await run({ store: STORE });
    const rerun = { ...SNAPSHOTS, "2026-11-03": { sol: [["A", 1], ["C", 900], ["W", 1]], sol2: [] } };
    const versions = new Map([["2026-11-01", "v1-2026-11-01"], ["2026-11-03", "v2-2026-11-03"]]);
    const next = await run({ store: STORE, snaps: rerun, versions });
    expect(next.reads).toEqual(["2026-11-03@v2-2026-11-03"]);
    expect(next.logs[0]).toMatch(/read snapshot 2026-11-03 \(v2-2026-\): version changed\./);
    expect(next.days).toEqual(reference(STORE, rerun));
  });

  it("re-reads every date when the rows rule changes", async () => {
    await run({ store: STORE });
    const next = await run({ store: STORE, basis: { ...BASIS, rowsRule: 2 } });
    expect(next.reads).toHaveLength(2);
    expect(next.logs[0]).toMatch(/file not usable \(another snapshot file, chains or rows rule\)/);
    expect(readDate("2026-11-01").basis.rowsRule).toBe(2);
    expect(next.days).toEqual(reference(STORE));
  });

  it("applies a changed exclusion or tier threshold with zero reads, equal to a from-scratch build", async () => {
    const base = await run({ store: STORE });
    const excl = new Set(["W"]);
    const tierOf = thresholdTier(10);
    const next = await run({ store: STORE, excl, tierOf });
    expect(next.reads).toEqual([]);
    expect(next.days).not.toEqual(base.days);
    expect(next.days).toEqual(reference(STORE, SNAPSHOTS, excl, tierOf));
  });

  it("prunes owners the store no longer names, and removes the file of a date it no longer needs", async () => {
    await run({ store: STORE });
    const shrunk = flowStore({ "2026-11-01": ["A"], "2026-11-02": ["W"] });
    const next = await run({ store: shrunk });
    expect(next.reads).toEqual([]);
    expect(readDate("2026-11-01").balances).toEqual({ A: 5, W: [60, 50] });
    expect(fs.readdirSync(dir)).toEqual(["2026-11-01.json"]);
    expect(next.logs.at(-1)).toBe("Tier counterparty days: snapshots read: 0 of 1; files written: 1, removed: 1.");
    expect(next.days).toEqual(reference(shrunk));
  });

  it.each([
    ["{}", {}],
    ["{ chains: {} }", { chains: {} }],
    ["chains with no days", { chains: { sol: { days: {} } } }],
  ])("leaves the folder byte-unchanged for a flow store with no days (%s); the full store then reads nothing", async (_label, empty) => {
    await run({ store: STORE });
    const before = fileStats();
    const blank = await run({ store: empty });
    expect(blank.reads).toEqual([]);
    expect(blank.logs).toEqual([
      "Tier counterparty days: the flow store names no snapshot dates; keeping every date file as it is.",
      "Tier counterparty days: snapshots read: 0 of 0; files written: 0, removed: 0.",
    ]);
    expect(fileStats()).toEqual(before);
    const full = await run({ store: STORE });
    expect(full.reads).toEqual([]);
    expect(full.days).toEqual(reference(STORE));
    expect(fileStats()).toEqual(before);
  });

  it("re-reads a date whose stored balance is not a finite number or a non-finite marker, never giving a NaN tier", async () => {
    await run({ store: STORE });
    const other = fileStats()["2026-11-03.json"];
    const edited = readDate("2026-11-01");
    edited.balances.A = "abc";
    fs.writeFileSync(dateFile("2026-11-01"), JSON.stringify(edited));
    const res = await run({ store: STORE });
    expect(res.reads).toEqual(["2026-11-01@v1-2026-11-01"]);
    expect(res.logs[0]).toMatch(/file not usable \(malformed balances\)/);
    expect(readDate("2026-11-01").balances.A).toBe(5);
    expect(res.days).toEqual(reference(STORE));
    expect(fileStats()["2026-11-03.json"]).toEqual(other);
  });

  it.each([["NaN"], ["Infinity"], ["-Infinity"]])("accepts the stored marker %s", (marker) => {
    const text = JSON.stringify({ schema: 1, basis: BASIS, version: "v", balances: { A: marker, B: [1, marker] } });
    expect(parseDateFile(text, BASIS).entry.balances.get("A")).toBe(marker);
  });

  it.each([["abc"], ["nan"], [""], [true], [{}]])("rejects the stored value %j", (value) => {
    const text = JSON.stringify({ schema: 1, basis: BASIS, version: "v", balances: { A: [1, value] } });
    expect(parseDateFile(text, BASIS).problem).toBe("malformed balances");
  });

  it("removes tmp files an interrupted write left, and nothing else", async () => {
    await run({ store: STORE });
    const before = fileStats();
    fs.writeFileSync(path.join(dir, "2026-11-01.json.tmp"), "{\"half");
    fs.writeFileSync(path.join(dir, "notes.tmp"), "kept");
    const res = await run({ store: STORE });
    expect(res.reads).toEqual([]);
    expect(res.logs[0]).toBe("Tier counterparty days: removed 1 leftover tmp file(s) from an interrupted write.");
    expect(fs.readdirSync(dir).sort()).toEqual(["2026-11-01.json", "2026-11-03.json", "notes.tmp"]);
    const after = fileStats();
    delete after["notes.tmp"];
    expect(after).toEqual(before);
  });

  it.each([
    ["corrupt JSON", "{\"schema\":1,\"basis\":{"],
    ["of another schema", JSON.stringify({ schema: 99, basis: BASIS, version: "v1-2026-11-01", balances: {} })],
    ["of another basis", JSON.stringify({ schema: 1, basis: { ...BASIS, chains: ["sol"] }, version: "v1-2026-11-01", balances: { A: 1e9, W: 1e9, X: 1e9 } })],
    ["malformed", JSON.stringify({ schema: 1, basis: BASIS, version: "v1-2026-11-01", balances: { A: { no: 1 } } })],
  ])("re-reads only the date whose file is %s, and matches the from-scratch result", async (_label, text) => {
    await run({ store: STORE });
    const other = fileStats()["2026-11-03.json"];
    fs.writeFileSync(dateFile("2026-11-01"), text);
    const res = await run({ store: STORE });
    expect(res.reads).toEqual(["2026-11-01@v1-2026-11-01"]);
    expect(res.days).toEqual(reference(STORE));
    expect(readDate("2026-11-01").schema).toBe(1);
    expect(fileStats()["2026-11-03.json"]).toEqual(other);
  });

  it("gives the from-scratch result with no folder at all", async () => {
    const res = await run({ store: STORE });
    expect(res.reads).toHaveLength(2);
    expect(res.days).toEqual(reference(STORE));
  });

  it("does not read a snapshot for a date whose days have no counterparties", async () => {
    const res = await run({ store: flowStore({ "2026-11-01": [] }) });
    expect(res.reads).toEqual([]);
  });

  it("stores and finds owners named like Object.prototype keys", async () => {
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    const snaps = { "2026-11-01": { sol: [["__proto__", 500], ["constructor", 7]], sol2: [["toString", 300]] } };
    const store = flowStore({ "2026-11-02": names });
    const first = await run({ store, snaps });
    const stored = readDate("2026-11-01").balances;
    expect(Object.keys(stored).sort()).toEqual([...names].sort());
    expect(Object.getOwnPropertyDescriptor(stored, "__proto__").value).toBe(500);
    expect(Object.getOwnPropertyDescriptor(stored, "hasOwnProperty").value).toBeNull();
    expect(first.days).toEqual(reference(store, snaps));
    expect(first.tierAt("2026-11-02").get("__proto__")).toBe("big");
    expect(first.tierAt("2026-11-02").get("constructor")).toBe("small");
    expect(first.tierAt("2026-11-02").has("hasOwnProperty")).toBe(false);

    const second = await run({ store, snaps });
    expect(second.reads).toEqual([]);
    expect(second.days).toEqual(first.days);
  });

  it("keeps the Hedera rule: a repeated row keeps the last tier any row had", async () => {
    const snaps = { "2026-11-01": { sol: [["0.0.5", 500], ["0.0.5", 0], ["0.0.6", 1]] } };
    const store = flowStore({ "2026-10-30": ["0.0.5"], "2026-11-02": ["0.0.5", "0.0.6", "0.0.7"] });
    const tierOf = thresholdTier(100);
    const r = reader(snaps);
    const { tierAt } = await resolveCounterpartyTiers({
      dir, basis: BASIS, store, snapDates: ["2026-11-01"], versions: versionsOf(snaps), readRows: r.readRows, log: () => {},
      tierOf: (owner, rows) => { let t = null; for (const v of rows) { const x = tierOf(v); if (x) t = x; } return t; },
    });
    const referenceAt = (date) => {
      if (date < "2026-11-01") return new Map();
      const tiers = new Map();
      for (const [a, v] of snaps["2026-11-01"].sol) { const t = tierOf(v); if (t) tiers.set(a, t); }
      return tiers;
    };
    const days = buildHederaTierDays(store, { decimals: { sol: 0 }, tierAt });
    expect(days).toEqual(buildHederaTierDays(store, { decimals: { sol: 0 }, tierAt: referenceAt }));
    expect(tierAt("2026-11-02").get("0.0.5")).toBe("big");
  });
});

describe("date file encoding", () => {
  it("round-trips rows through JSON, including non-finite balances", () => {
    for (const rows of [[], [0], [1.5e-8], [60, 50], [Number.NaN], [Infinity, 2]]) {
      expect(decodeRows(JSON.parse(JSON.stringify(encodeRows(rows))))).toEqual(rows);
    }
  });

  it("round-trips a prototype-named owner through serialize and parse", () => {
    const balances = new Map([["__proto__", 1], ["constructor", null]]);
    const parsed = parseDateFile(serializeDateFile(BASIS, "v", balances), BASIS);
    expect([...parsed.entry.balances]).toEqual([["__proto__", 1], ["constructor", null]]);
  });
});
