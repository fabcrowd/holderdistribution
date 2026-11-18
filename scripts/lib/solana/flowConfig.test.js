import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flowFloor, latestRowFloorWarning, recordedFlowFloor, resolveFlowFloor, trustedRecordedSince } from "./flowConfig.js";
import { carryOverRecordedFlowFloor, firstLiveDateOf, firstLiveDateState, generatorFirstLiveDate, keepFirstLiveDate } from "../firstLiveDate.js";
import { mergeHistoryEntries } from "./holderReplay.js";

const scriptsDir = path.resolve(import.meta.dirname, "..", "..");

describe("flowFloor", () => {
  let dir;
  let historyPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-floor-"));
    historyPath = path.join(dir, "holders-history.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeHistory = (dates, extra = {}) => fs.writeFileSync(historyPath, JSON.stringify({ ...extra, entries: dates.map((date) => ({ date })) }));

  it("firstLiveDate wins over the checkpoint's recorded floor", () => {
    writeHistory(["2026-10-20", "2026-10-25"], { firstLiveDate: "2026-10-25" });
    const checkpoint = { chains: { solana: { since: "2026-10-20" } } };
    expect(flowFloor({ checkpoint, chainKeys: ["solana"], historyPath })).toEqual({ since: "2026-10-25", source: "firstLiveDate" });
  });

  it("a one-off override stays one-off: the default run after an override run returns the first live day", () => {
    writeHistory(["2024-01-17", "2026-11-05", "2026-11-06"], { firstLiveDate: "2026-11-05" });
    // The override run (--since 2026-12-01) recorded its floor in the checkpoint.
    const afterOverride = { chains: { solana: { since: "2026-12-01" } } };
    expect(flowFloor({ checkpoint: afterOverride, chainKeys: ["solana"], historyPath }).since).toBe("2026-11-05");
  });

  it("on a first scan uses firstLiveDate, not the earliest row, when history was backfilled before the first live day", () => {
    // First live snapshot 2026-11-05; onboarding then backfilled from historyStart 2024-01-17.
    writeHistory(["2024-01-17", "2024-01-18", "2026-11-04", "2026-11-05", "2026-11-06"], { firstLiveDate: "2026-11-05" });
    expect(flowFloor({ checkpoint: { chains: {} }, chainKeys: ["solana"], historyPath }).since).toBe("2026-11-05");
    expect(flowFloor({ checkpoint: null, chainKeys: ["solana"], historyPath }).since).toBe("2026-11-05");
  });

  it("without a firstLiveDate day uses the recorded floor (earliest across the scanned chains)", () => {
    writeHistory(["2026-10-25", "2026-11-17"]);
    const checkpoint = { chains: { a: { since: "2026-11-02" }, b: { since: "2026-11-01" }, other: { since: "2020-01-01" } } };
    expect(flowFloor({ checkpoint, chainKeys: ["a", "b"], historyPath })).toEqual({ since: "2026-11-01", source: "checkpoint" });
    writeHistory(["2026-10-25"], { firstLiveDate: null });
    expect(flowFloor({ checkpoint, chainKeys: ["a"], historyPath }).source).toBe("checkpoint");
  });

  it("with neither, falls back to the latest row (never the earliest) and the scans get a warning", () => {
    writeHistory(["2024-01-17", "2026-11-16", "2026-11-15"]);
    const floor = flowFloor({ checkpoint: { chains: {} }, chainKeys: ["hedera"], historyPath });
    expect(floor).toEqual({ since: "2026-11-16", source: "latestRow" });
    expect(latestRowFloorWarning("hedera", floor)).toMatch(/^hedera: .*latest history row 2026-11-16/);
    expect(latestRowFloorWarning("hedera", { since: "2026-11-14", source: "firstLiveDate" })).toBeNull();
  });

  it("is null with no recorded floor and no history file or rows", () => {
    expect(flowFloor({ checkpoint: { chains: {} }, chainKeys: ["solana"], historyPath })).toEqual({ since: null, source: null });
    writeHistory([]);
    expect(flowFloor({ checkpoint: { chains: {} }, chainKeys: ["solana"], historyPath }).since).toBeNull();
  });
});

// The scans need RPC, so a run is simulated with the function they call (resolveFlowFloor) and the entry they
// write: both rebuild chains.<key> fresh as `{ ..., since, ...floor.markers, ... }` (pinned by a source check below).
describe("override runs stay one-off (resolveFlowFloor + the scans' checkpoint entry)", () => {
  let dir;
  let historyPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-override-"));
    historyPath = path.join(dir, "holders-history.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const KEY = "solana";
  const writeHistory = (history) => fs.writeFileSync(historyPath, JSON.stringify(history));
  const runScan = (checkpoint, override = null) => {
    const floor = resolveFlowFloor({ override, checkpoint, chainKeys: [KEY], historyPath });
    const chains = { ...checkpoint.chains, [KEY]: { mint: "M", since: floor.since, ...floor.markers, accounts: {}, complete: false } };
    return { floor, checkpoint: { ...checkpoint, chains } };
  };
  const rows = (dates) => dates.map((date) => ({ date }));

  it.each([
    ["known date", { firstLiveDate: "2026-10-25", entries: rows(["2024-01-17", "2026-10-25", "2026-11-17"]) }, "2026-10-25"],
    ["null (pending)", { firstLiveDate: null, entries: rows(["2024-01-17", "2026-11-17"]) }, "2026-10-25"],
    ["absent (unknown)", { entries: rows(["2026-10-25", "2026-11-17"]) }, "2026-10-25"],
  ])("firstLiveDate %s: override run, then default run returns the pre-override floor", (_label, history, expected) => {
    writeHistory(history);
    const start = { chains: { [KEY]: { mint: "M", since: "2026-10-25", accounts: {} } } };
    const over = runScan(start, "2026-12-01");
    expect(over.floor.since).toBe("2026-12-01");
    expect(over.checkpoint.chains[KEY]).toMatchObject({ since: "2026-12-01", sinceSource: "override", defaultSince: "2026-10-25" });
    const next = runScan(over.checkpoint);
    expect(next.floor.since).toBe(expected);
    // The default run's rebuilt entry drops the markers.
    expect(next.checkpoint.chains[KEY]).not.toHaveProperty("sinceSource");
    expect(next.checkpoint.chains[KEY]).not.toHaveProperty("defaultSince");
    expect(next.checkpoint.chains[KEY].since).toBe(expected);
  });

  it.each([
    ["known date", { firstLiveDate: "2026-10-25", entries: rows(["2026-10-25", "2026-11-17"]) }, { firstLiveDate: "2026-10-25" }],
    ["null (pending)", { firstLiveDate: null, entries: rows(["2024-01-17"]) }, { firstLiveDate: null }],
    ["absent (unknown)", { entries: rows(["2026-10-25", "2026-11-17"]) }, { firstLiveDate: "2026-10-25" }],
  ])("firstLiveDate %s: the generator after an override run never copies the override", (_label, history, expected) => {
    writeHistory(history);
    const over = runScan({ chains: { [KEY]: { mint: "M", since: "2026-10-25", accounts: {} } } }, "2026-12-01");
    expect(carryOverRecordedFlowFloor(history, over.checkpoint, [KEY])).toBe("firstLiveDate" in history ? null : "2026-10-25");
    // No live row this run, so a pending history stays pending.
    expect(generatorFirstLiveDate(history, null, over.checkpoint, [KEY])).toEqual(expected);
  });

  it("two override runs in a row keep the pre-override floor as defaultSince", () => {
    writeHistory({ entries: rows(["2026-10-25", "2026-11-17"]) });
    const first = runScan({ chains: { [KEY]: { mint: "M", since: "2026-10-25", accounts: {} } } }, "2026-12-01");
    const second = runScan(first.checkpoint, "2026-12-05");
    expect(second.checkpoint.chains[KEY]).toMatchObject({ since: "2026-12-05", defaultSince: "2026-10-25" });
    expect(runScan(second.checkpoint).floor.since).toBe("2026-10-25");
  });

  it("an override with no default floor at all records no defaultSince", () => {
    const over = runScan({ chains: {} }, "2026-12-01");
    expect(over.checkpoint.chains[KEY]).toMatchObject({ since: "2026-12-01", sinceSource: "override" });
    expect(over.checkpoint.chains[KEY]).not.toHaveProperty("defaultSince");
    expect(recordedFlowFloor(over.checkpoint, [KEY])).toBeNull();
  });

  it("latest-row fallback: two default runs in a row give the same floor (no flip), and only the first warns", () => {
    writeHistory({ entries: rows(["2026-11-16"]) });
    const first = runScan({ chains: {} });
    expect(first.floor).toMatchObject({ since: "2026-11-16", source: "latestRow" });
    writeHistory({ entries: rows(["2026-11-16", "2026-11-17"]) });
    const second = runScan(first.checkpoint);
    expect(second.floor).toMatchObject({ since: "2026-11-16", source: "checkpoint" });
    expect(latestRowFloorWarning("x", second.floor)).toBeNull();
  });

  it("entries written before the markers existed are trusted as is", () => {
    expect(trustedRecordedSince({ since: "2026-10-25" })).toBe("2026-10-25");
    expect(trustedRecordedSince({ since: "2026-12-01", sinceSource: "override", defaultSince: "2026-10-25" })).toBe("2026-10-25");
    expect(trustedRecordedSince({ since: "2026-12-01", sinceSource: "override" })).toBeUndefined();
  });
});

describe("firstLiveDate states (holders-history.json)", () => {
  it("classifies known, pending and unknown", () => {
    expect(firstLiveDateState({ firstLiveDate: "2026-11-05", entries: [{ date: "2026-11-05" }] })).toBe("known");
    expect(firstLiveDateState(null)).toBe("pending");
    expect(firstLiveDateState({ entries: [] })).toBe("pending");
    expect(firstLiveDateState({ firstLiveDate: null, entries: [{ date: "2024-01-17" }] })).toBe("pending");
    expect(firstLiveDateState({ entries: [{ date: "2024-01-17" }] })).toBe("unknown");
  });

  it("firstLiveDateOf: known stays, pending takes the live row (null keeps it pending), unknown writes nothing", () => {
    expect(firstLiveDateOf({ firstLiveDate: "2026-11-05", entries: [{}] }, "2026-11-20")).toBe("2026-11-05");
    expect(firstLiveDateOf(null, "2026-11-05")).toBe("2026-11-05");
    expect(firstLiveDateOf({ firstLiveDate: null, entries: [{ date: "2024-01-17" }] }, null)).toBeNull();
    expect(firstLiveDateOf({ entries: [{ date: "2024-01-17" }] }, "2026-11-17")).toBeUndefined();
  });

  it("generatorFirstLiveDate writes null for pending, the carry-over or nothing for unknown", () => {
    expect(generatorFirstLiveDate(null, null, null, [])).toEqual({ firstLiveDate: null });
    expect(generatorFirstLiveDate(null, "2026-11-05", null, [])).toEqual({ firstLiveDate: "2026-11-05" });
    const unknown = { entries: [{ date: "2026-10-25" }] };
    expect(generatorFirstLiveDate(unknown, "2026-11-17", { chains: { solana: { since: "2026-10-25" } } }, ["solana"])).toEqual({ firstLiveDate: "2026-10-25" });
    expect(generatorFirstLiveDate(unknown, "2026-11-17", null, ["solana"])).toEqual({});
  });
});

describe("carryOverRecordedFlowFloor (one-time, coins onboarded before firstLiveDate)", () => {
  const rows = { entries: [{ date: "2026-10-25" }, { date: "2026-11-17" }] };

  it("rows, no field, checkpoint since: copies the recorded floor (earliest across flow chains)", () => {
    expect(carryOverRecordedFlowFloor(rows, { chains: { solana: { since: "2026-10-25" } } }, ["solana"])).toBe("2026-10-25");
    const two = { chains: { a: { since: "2026-11-02" }, b: { since: "2026-11-01" }, evm: { since: "2020-01-01" } } };
    expect(carryOverRecordedFlowFloor(rows, two, ["a", "b"])).toBe("2026-11-01");
  });

  it("rows, no field, no checkpoint or no since: unchanged (null)", () => {
    expect(carryOverRecordedFlowFloor(rows, null, ["solana"])).toBeNull();
    expect(carryOverRecordedFlowFloor(rows, { chains: {} }, ["solana"])).toBeNull();
    expect(carryOverRecordedFlowFloor(rows, { chains: { solana: { since: "2026-10-25" } } }, [])).toBeNull();
  });

  it("field already set: unchanged even when the checkpoint differs", () => {
    const set = { ...rows, firstLiveDate: "2026-10-24" };
    const ckpt = { chains: { solana: { since: "2026-10-25" } } };
    expect(carryOverRecordedFlowFloor(set, ckpt, ["solana"])).toBeNull();
    expect(generatorFirstLiveDate(set, "2026-11-17", ckpt, ["solana"])).toEqual({ firstLiveDate: "2026-10-24" });
  });

  it("does not apply to a pending history (empty, or null field)", () => {
    const ckpt = { chains: { solana: { since: "2026-10-25" } } };
    expect(carryOverRecordedFlowFloor({ entries: [] }, ckpt, ["solana"])).toBeNull();
    expect(carryOverRecordedFlowFloor({ firstLiveDate: null, entries: [{ date: "2024-01-17" }] }, ckpt, ["solana"])).toBeNull();
  });
});

// rebuild-holders-history-solana.js and rebuild-history-from-logs.js need RPC / Etherscan to run, so their write is
// tested at the payload they build: `{ generatedAt, source, ...keepFirstLiveDate(existing), entries }`.
describe("rebuild writers keep firstLiveDate (payload level)", () => {
  const replayed = ["2024-01-17", "2024-01-18", "2026-11-05", "2026-11-06"].map((date) => ({ date }));
  const solanaPayload = (existing) => ({
    generatedAt: "y",
    source: "rebuild-holders-history-solana",
    ...keepFirstLiveDate(existing),
    entries: mergeHistoryEntries(existing?.entries ?? [], replayed),
  });
  const logsPayload = (existing) => ({ generatedAt: "y", source: "rebuild-history-from-logs", ...keepFirstLiveDate(existing), entries: replayed });

  it.each([
    ["rebuild-holders-history-solana", solanaPayload],
    ["rebuild-history-from-logs", logsPayload],
  ])("%s: a known day survives a rewrite that adds earlier rows and replaces the live ones", (_name, build) => {
    const live = { firstLiveDate: "2026-11-05", entries: [{ date: "2026-11-05", live: true }, { date: "2026-11-06", live: true }] };
    const rebuilt = build(live);
    expect(rebuilt.entries[0].date).toBe("2024-01-17");
    expect(rebuilt.firstLiveDate).toBe("2026-11-05");
    expect(generatorFirstLiveDate(rebuilt, "2026-11-20", null, [])).toEqual({ firstLiveDate: "2026-11-05" });
  });

  it.each([
    ["rebuild-holders-history-solana", solanaPayload],
    ["rebuild-history-from-logs", logsPayload],
  ])("%s: writing into a missing or empty history records null, so the next live row sets the day", (_name, build) => {
    for (const existing of [null, { entries: [] }, { firstLiveDate: null, entries: [{ date: "2024-01-17" }] }]) {
      const rebuilt = build(existing);
      expect(Object.hasOwn(rebuilt, "firstLiveDate")).toBe(true);
      expect(rebuilt.firstLiveDate).toBeNull();
      expect(generatorFirstLiveDate(rebuilt, "2026-11-20", null, [])).toEqual({ firstLiveDate: "2026-11-20" });
    }
  });

  it.each([
    ["rebuild-holders-history-solana", solanaPayload],
    ["rebuild-history-from-logs", logsPayload],
  ])("%s: an unknown history (rows, no field) stays unknown", (_name, build) => {
    expect(Object.hasOwn(build({ entries: [{ date: "2024-01-17" }] }), "firstLiveDate")).toBe(false);
  });
});

describe("flow scans do not read the floor from git", () => {
  it.each(["scan-solana-flows.js", "scan-hedera-flows.js", "lib/solana/flowConfig.js"])("%s has no git call", (file) => {
    const src = fs.readFileSync(path.join(scriptsDir, file), "utf8");
    expect(src).not.toMatch(/child_process|firstSnapshotDate|["']git["']/);
  });

  it.each([
    ["scan-solana-flows.js", /checkpoint\.chains\[c\.key\] = \{ mint: c\.mint, since, \.\.\.floor\.markers,/],
    ["scan-hedera-flows.js", /let state = \{\s+since,\s+\.\.\.floor\.markers,/],
  ])("%s writes the floor markers on the checkpoint entry it rebuilds", (file, pattern) => {
    const src = fs.readFileSync(path.join(scriptsDir, file), "utf8");
    expect(src).toMatch(pattern);
    expect(src).toMatch(/resolveFlowFloor\(\{ override,/);
  });

  it.each([
    ["rebuild-holders-history-solana.js", /\.\.\.keepFirstLiveDate\(existingDoc\)/],
    ["rebuild-history-from-logs.js", /\.\.\.keepFirstLiveDate\(await readJsonOr\(HISTORY_PATH, null\)\)/],
  ])("%s builds its payload with keepFirstLiveDate (the function tested above)", (file, pattern) => {
    expect(fs.readFileSync(path.join(scriptsDir, file), "utf8")).toMatch(pattern);
  });
});
