// The file seams of scripts/store-publish.js: the workflow step writes the origin/main facts and the
// downloaded candidates into directories, the CLI reads them and writes its outputs into another
// (nothing here runs git or the network; laneCli.js's rule). Layout, all under `manifests/` of the
// origin directory and of the output directory alike:
//   manifests/<slug>.json | manifests/<slug>.absent   the coin's manifest on main, or the marker (laneCli.js fileGit)
//   manifests/store.json                              required (the empty store file when main has none)
//   manifests/site.json                               required by the sweep phase (`{ "schema": 1, "root": null }` when none)
//   manifests/index/<slug>.json                       the coin's state index rows (publishIndex.js); none: no rows yet
// A missing required file stops the step with OriginFactsError: an empty answer would publish over, or sweep away,
// what main holds.
import fs from "node:fs";
import path from "node:path";
import { OriginFactsError } from "./laneNames.js";
import { fileGit } from "./laneCli.js";
import { parseSiteFile, siteRootLoc } from "./pointerFiles.js";
import { parseIndexFile, serializeIndexFile } from "./publishIndex.js";

const RESERVED = new Set(["store", "site"]);

function walkJson(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJson(full));
    else if (e.name.endsWith(".json")) out.push(full);
  }
  return out;
}

// Every `.json` file under `dir`, as { name, text }, in name order.
export function readCandidates(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new OriginFactsError(`candidates directory ${dir} does not exist (the workflow creates it, empty when no lane uploaded a candidate)`);
  return walkJson(dir).map((file) => ({ name: path.relative(dir, file).split(path.sep).join("/"), text: fs.readFileSync(file, "utf8") }));
}

export function originSeams(dir) {
  const git = fileGit(dir);
  return {
    readManifest: git.readManifest,
    readStoreFile: git.readStoreFile,
    index: {
      load: async (slug) => {
        const file = path.join(dir, "manifests", "index", `${slug}.json`);
        return fs.existsSync(file) ? parseIndexFile(fs.readFileSync(file, "utf8"), slug) : [];
      },
    },
  };
}

// The site root's location on main, or null when the file says there is none.
export function readSiteRoot(dir) {
  const file = path.join(dir, "manifests", "site.json");
  if (!fs.existsSync(file)) throw new OriginFactsError(`manifests/site.json is missing from ${dir}`);
  const { root } = parseSiteFile(fs.readFileSync(file, "utf8"));
  return root === null ? null : siteRootLoc(root);
}

// The slugs that have a manifest file on main.
export function manifestSlugs(dir) {
  const base = path.join(dir, "manifests");
  if (!fs.existsSync(base)) throw new OriginFactsError(`manifests/ is missing from ${dir}`);
  return fs.readdirSync(base).filter((n) => n.endsWith(".json") && !RESERVED.has(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort();
}

function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function outSeams(outDir) {
  return {
    writeManifest: async (slug, text) => put(outDir, `manifests/${slug}.json`, text),
    writeIndex: async (slug, rows) => put(outDir, `manifests/index/${slug}.json`, serializeIndexFile(slug, rows)),
    writeStoreFile: async (text) => put(outDir, "manifests/store.json", text),
  };
}

// The issues file the workflow reads to raise issues (this code makes no gh call).
export function writeIssues(file, record) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

export function readAlerts(file) {
  if (!fs.existsSync(file)) throw new OriginFactsError(`--adoption-alerts ${file} does not exist`);
  let v;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new OriginFactsError(`${file} is not JSON (${err.message})`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new OriginFactsError(`${file} must be a map of slug to a list of { code, count }`);
  return v;
}
