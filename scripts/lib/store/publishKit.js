// Test helpers for the publish tests (publish, publishSweep, store-publish CLI): in-memory seams for
// the manifests, the index rows and the three outputs, and candidate files built from entries that
// recordKit.js wrote through real packs. Not a test file itself. Neutral slugs only.
import { buildCandidate, serializeCandidate } from "./candidate.js";
import { serializeManifest } from "./manifest.js";
import { serializeStoreFile } from "./pointerFiles.js";
import { bundleKey } from "./bundle.js";

export const PUBLISH_AT = "2026-11-18T03:12:40Z";
export const clockAt = (iso = PUBLISH_AT) => () => Date.parse(iso);
export const emptyStoreText = () => serializeStoreFile({ schema: 1, releases: {} });

// A candidate file's text for `kind`; `chains` maps slug -> entries (oldest first, the run's last).
export function candidateText({ kind = "holders", run, chains }) {
  const coins = Object.fromEntries(Object.entries(chains).map(([slug, chain]) => [slug, { chain, files: {} }]));
  return serializeCandidate(buildCandidate({ kind, run, coins }));
}

export const asCandidate = (name, text) => ({ name, text });

// The next night of a coin written by recordKit.writeCoins: the spec that makes `rec` its parent.
export const childOf = (rec) => ({ parent: bundleKey(rec.bundleRef), parentUsage: rec.entry.usage });

// Seams over memory. `manifests` maps slug -> manifest object (absent: no manifest on main), `index` maps
// slug -> rows. `readFails` names coins whose manifest read throws, `writeFails` coins whose manifest
// write throws. Everything written is in `written`.
export function memorySeams({ manifests = {}, store = emptyStoreText(), index = {}, readFails = [], writeFails = [] } = {}) {
  const written = { manifests: new Map(), index: new Map(), store: null, order: [] };
  return {
    written,
    readManifest: async (slug) => {
      if (readFails.includes(slug)) throw new Error(`cannot read the manifest of ${slug}`);
      const m = written.manifests.get(slug) ?? manifests[slug];
      return typeof m === "string" ? m : m === undefined ? null : serializeManifest(m);
    },
    readStoreFile: async () => store,
    index: { load: async (slug) => structuredClone(written.index.get(slug) ?? index[slug] ?? []) },
    out: {
      writeManifest: async (slug, text) => {
        if (writeFails.includes(slug)) throw new Error(`cannot write the manifest of ${slug}`);
        written.manifests.set(slug, text);
        written.order.push(`manifest:${slug}`);
      },
      writeIndex: async (slug, rows) => {
        written.index.set(slug, rows);
        written.order.push(`index:${slug}`);
      },
      writeStoreFile: async (text) => {
        written.store = text;
        written.order.push("store");
      },
    },
  };
}

// A blob store that counts range reads (all packs together).
export function countingBlobs(blobs) {
  const count = { reads: 0 };
  return { blobs: { ...blobs, readRange: (...a) => { count.reads++; return blobs.readRange(...a); } }, count };
}
