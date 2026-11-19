#!/usr/bin/env node
// Runs the synthetic ledger at a given size through the shared readers and prints one JSON line: time, peak
// memory (rss, sampled once per page), rows and requests. This is the size proof of the design: the same code
// at any number of accounts, memory bounded by the page and range size. The exception is the changes read:
// unless the adapter sorts its changes, the reader remembers each changed account of the interval, so memory
// grows with days x changes (the JSON line says whether the changes were read sorted).
// Measured: memory does not follow the number of accounts (same changes per day at 1M and 100M accounts give
// the same peak); unsorted changes cost memory per changed account of the interval, bounded by
// `--max-tracked` (the reader's maxTrackedAccounts).
//   node scripts/adapter-size-run.js --accounts 1000000 --changes 10000 --days 3
import v8 from "node:v8";
import vm from "node:vm";
import { readChanges, readFullList } from "./lib/adapter/read.js";
import { createSyntheticAdapter } from "./lib/adapter/synthetic.js";

const DEFAULT_DAYS = 3;
const DEFAULT_PAGE_ROWS = 1000;
const ROWS_PER_RANGE = 50_000;
const GC_EVERY_PAGES = 50;
const MIN_ROWS_FOR_ESTIMATE = 10_000;
const BYTES_PER_MB = 1024 * 1024;

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`expected "--name value" pairs, got ${argv.slice(i).join(" ")}`);
    values[key.slice(2)] = argv[i + 1];
  }
  const number = (name, fallback) => {
    const n = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${values[name]}`);
    return n;
  };
  const accounts = number("accounts");
  return {
    accounts,
    changes: number("changes", Math.max(1, Math.floor(accounts / 100))),
    days: number("days", DEFAULT_DAYS),
    seed: number("seed", 1),
    pageRows: number("page-rows", DEFAULT_PAGE_ROWS),
    ranges: number("ranges", Math.ceil(accounts / ROWS_PER_RANGE)),
    maxTracked: values["max-tracked"] === undefined ? undefined : number("max-tracked"),
  };
}

// Counts the calls the readers make, so "requests" is what the ledger would be asked, retries included.
function countRequests(adapter, counts) {
  const counted = (name) => (...args) => {
    counts[name] += 1;
    return adapter[name](...args);
  };
  return { ...adapter, fullList: counted("fullList"), changes: counted("changes") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const synthetic = createSyntheticAdapter({ seed: args.seed, accounts: args.accounts, changesPerDay: args.changes, days: args.days, maxPageRows: args.pageRows, stakeShare: 0 });
  const requests = { fullList: 0, changes: 0 };
  const adapter = countRequests(synthetic, requests);
  const supply = synthetic.discover(null).supply;
  const day = (d) => synthetic.settledEnd(null, new Date(Date.parse("2026-01-01T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10));
  let peakRss = process.memoryUsage().rss;
  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  const started = process.hrtime.bigint();
  const full = await readFullList(adapter, null, day(args.days), { n: args.ranges, onRows: sample });
  // Live heap after a forced collection every GC_EVERY_PAGES pages of the changes read: what the repeat check
  // holds, without garbage. Bytes per tracked account is that heap over the rows delivered so far.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let changePages = 0;
  let deliveredRows = 0;
  let bytesPerTracked = null;
  const onChanges = (rows) => {
    sample();
    deliveredRows += rows.length;
    if (++changePages % GC_EVERY_PAGES === 0 && deliveredRows >= MIN_ROWS_FOR_ESTIMATE) {
      gc();
      bytesPerTracked = Math.round((process.memoryUsage().heapUsed - heapBefore) / deliveredRows);
    }
  };
  const changed = await readChanges(adapter, null, day(0), day(args.days), { onRows: onChanges, ...(args.maxTracked === undefined ? {} : { maxTrackedAccounts: args.maxTracked }) });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  sample();

  if (full.sum !== supply) throw new Error(`full list sums to ${full.sum}, supply is ${supply}`);
  const line = {
    accounts: args.accounts,
    changesPerDay: args.changes,
    changesSorted: synthetic.capabilities.sortedChanges === true,
    ...(args.maxTracked === undefined ? {} : { maxTracked: args.maxTracked }),
    ...(bytesPerTracked === null ? {} : { bytesPerTrackedAccount: bytesPerTracked }),
    days: args.days,
    ranges: args.ranges,
    ms,
    peakRssMb: Math.round(peakRss / BYTES_PER_MB),
    rows: { full: full.rows, changes: changed.rows },
    requests: { ...requests, total: requests.fullList + requests.changes },
    supplyMatches: true,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code ? `${error.code} (tracked ${error.tracked}, bound ${error.bound}): ` : ""}${error.message}\n`);
  process.exit(1);
});
