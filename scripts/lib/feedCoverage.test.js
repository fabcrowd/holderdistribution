/**
 * Ties the feeds the browser fetches to the two gates that protect them:
 *   (i)  netlify/functions/live-data.mjs must serve the file (else the live site 404s on it), and
 *   (ii) go-live must require the file for every registered project (else it can be missing or stale unnoticed).
 * A hook that starts fetching a feed neither gate knows fails here. A feed the gates deliberately do not
 * cover goes in EXEMPT with the reason; an exemption nothing needs any more fails too.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requiredFeedFiles } from "./goLive.js";
import { loadRegistry, resolveProject } from "./projects.js";
import { LIVE_DATA_FILES } from "../../netlify/functions/live-data.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCANNED_DIRS = ["src/hooks", "src/lib"];

/** Feeds the browser fetches that go-live does not require, with why that is acceptable. */
const EXEMPT = Object.freeze({
  "chain-status.json": "derived from holders-checkpoint.json by scripts/write-chain-status.js every refresh; go-live requires the checkpoint it is built from",
});

const FEED_NAME = "([\\w.-]+\\.json)";
const QUOTE = "[\"'`]";
const FETCH_PATTERNS = [
  new RegExp(`\\b(?:dataUrl\\([^,()]+,|resolveDataUrl\\()\\s*${QUOTE}${FEED_NAME}${QUOTE}`, "g"), // the shared URL helper
  new RegExp(`\\b[A-Z][A-Z_]*FEED\\s*(?::[^=]+)?=\\s*${QUOTE}${FEED_NAME}${QUOTE}`, "g"), // exported feed-name constants
  new RegExp(`\\bfetch\\(\\s*${QUOTE}[^"'\`]*?${FEED_NAME}${QUOTE}`, "g"), // direct fetch of a literal
];

/** Feed file names a source text passes to the shared fetch helper (or names as a *_FEED constant). */
export function feedNamesIn(source) {
  const names = new Set();
  for (const pattern of FETCH_PATTERNS) for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

const sourceFiles = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : [];
  });

const fetchedFeeds = () => new Set(SCANNED_DIRS.flatMap(sourceFiles).flatMap((file) => [...feedNamesIn(fs.readFileSync(path.join(ROOT, file), "utf8"))]));

const projects = loadRegistry(ROOT).map((entry) => resolveProject(entry.slug, ROOT));
const required = (project) => new Set(requiredFeedFiles(project, ROOT));

/** Feeds that a gate does not know: not served by live-data, or required by go-live for no one and not exempt. */
export function uncoveredFeeds(feeds, { served = LIVE_DATA_FILES, requiredByProject = projects.map(required), exempt = EXEMPT } = {}) {
  return [...feeds].flatMap((feed) => {
    const problems = [];
    if (!served.has(feed)) problems.push(`${feed}: not in LIVE_DATA_FILES (netlify/functions/live-data.mjs), so the live site 404s on it`);
    if (!(feed in exempt) && requiredByProject.some((files) => !files.has(feed))) {
      problems.push(`${feed}: not required by go-live for every project (add it to the required feeds in scripts/workflow-paths.js, or to EXEMPT in feedCoverage.test.js with a reason)`);
    }
    return problems;
  });
}

describe("browser feed coverage", () => {
  const feeds = fetchedFeeds();

  it("finds the feeds the hooks fetch", () => {
    expect(feeds.size).toBeGreaterThanOrEqual(8);
    expect(feeds).toContain("holders-lite.json");
    expect(feeds).toContain("tier-outflows.json");
  });

  it("every fetched feed is served by live-data and required by go-live (or exempt)", () => {
    expect(uncoveredFeeds(feeds)).toEqual([]);
  });

  it("fails for a feed neither gate knows", () => {
    const hook = 'const resolveUrl = (slug: string) => dataUrl(slug, "brand-new-feed.json");';
    expect(uncoveredFeeds(feedNamesIn(hook)).join("\n")).toMatch(/brand-new-feed\.json: not in LIVE_DATA_FILES[\s\S]*brand-new-feed\.json: not required by go-live/);
  });

  it("recognizes the fetch forms the code uses", () => {
    expect([...feedNamesIn('dataUrl(slug, "a.json", { base })')]).toEqual(["a.json"]);
    expect([...feedNamesIn('resolveDataUrl("b.json")')]).toEqual(["b.json"]);
    expect([...feedNamesIn('export const X_FEED = "c.json";')]).toEqual(["c.json"]);
    expect([...feedNamesIn("await fetch(`/data/d.json`)")]).toEqual(["d.json"]);
  });

  it("keeps every exemption honest: fetched, and genuinely not required", () => {
    for (const feed of Object.keys(EXEMPT)) {
      expect(feeds, `${feed} is exempt but no hook fetches it`).toContain(feed);
      expect(projects.some((project) => !required(project).has(feed)), `${feed} is exempt but go-live already requires it`).toBe(true);
    }
  });
});
