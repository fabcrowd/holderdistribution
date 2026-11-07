#!/usr/bin/env node
/**
 * Checks that every published feed of each registry project ends at the same
 * settled day / block.
 *
 *   node scripts/check-feed-alignment.js [--project <slug>] [--block-tolerance N] [--strict]
 *
 * Exits 1 when any project is misaligned (settled end dates differ, or blocks
 * differ beyond --block-tolerance). --strict also fails feeds that carry no
 * asOf stamp (default: a WARN line). Feeds stamped asOf.settled === false and
 * chains listed in asOf.live (Solana live reads) are reported as
 * "comparison skipped: live chain", never failed. A feed the project must
 * publish (lib/goLive.js requiredFeedFiles) that is absent is "missing feed":
 * a WARN line, a failure under --strict. Checkpoint scan heads print as INFO.
 * pipeline-health.js runs alignmentReport() as a report-only warning.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRegistry, resolveProject } from "./lib/projects.js";
import { summarizeFeed, compareFeeds } from "./lib/feedAlignment.js";
import { requiredFeedFiles } from "./lib/goLive.js";

// feed file -> checkpoint whose lastBlock is the feed's block source (if any)
const FEEDS = [
  ["exchange-flow-history.json", "exchange-flow-checkpoint.json"],
  ["tier-outflows.json", null],
  ["cex-balance-history.json", null],
  ["holders-history.json", "holders-checkpoint.json"],
  ["treasury-history.json", null],
  ["holder-transitions.json", null],
  ["holders-lite.json", "holders-checkpoint.json"],
];

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);

/** [{ slug, dataDir, feeds, result }] for every registry project (or just `only`). */
export function alignmentReport({ root = process.cwd(), only = null, strict = false, blockTolerance = 0 } = {}) {
  const out = [];
  for (const { slug } of loadRegistry(root)) {
    if (only && slug !== only) continue;
    const project = resolveProject(slug, root);
    const dir = path.resolve(root, project.dataDir);
    const required = new Set(requiredFeedFiles(project, root));
    const feeds = [];
    const missing = [];
    for (const [file, cp] of FEEDS) {
      const name = file.replace(/\.json$/, "");
      const json = readJson(path.join(dir, file));
      if (!json) {
        if (required.has(file)) missing.push(name);
        continue;
      }
      feeds.push(summarizeFeed(name, json, cp ? readJson(path.join(dir, cp)) : null));
    }
    out.push({ slug, dataDir: project.dataDir, feeds, result: compareFeeds(feeds, { blockTolerance, strict, missing }) });
  }
  return out;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const report = alignmentReport({
    strict: argv.includes("--strict"),
    blockTolerance: Number(flag("--block-tolerance") ?? 0),
    only: flag("--project") ?? null,
  });
  for (const { slug, dataDir, feeds, result: r } of report) {
    console.log(`\n== ${slug} (${dataDir}) ${r.ok ? "ALIGNED" : "MISALIGNED"}`);
    console.table(
      feeds.map((f) => ({
        feed: f.name,
        settledEnd: f.endDate,
        lastRow: f.rawLastDate,
        stamped: f.stamped,
        blocks: f.blocks ? Object.entries(f.blocks).map(([c, b]) => `${c}:${b}`).join(" ") : "",
        blockSrc: f.blockSource ?? "",
      })),
    );
    for (const p of r.problems) console.log(`  FAIL ${p}`);
    for (const w of r.warnings) console.log(`  WARN ${w}`);
    for (const s of r.skipped) console.log(`  SKIP ${s}`);
    for (const i of r.info) console.log(`  INFO ${i}`);
  }
  process.exit(report.some((p) => !p.result.ok) ? 1 : 0);
}
