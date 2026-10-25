/**
 * Node-side view of the multi-token project registry (config/projects.json +
 * config/projects/<slug>.json). Used by the build (prune-dist-data.js), the
 * Vite dev server (vite.config.ts) and tests. The browser has its own typed
 * copy in src/lib/projects.ts; netlify/functions/live-data.mjs keeps a tiny
 * constant list that scripts/lib/projects.test.js holds in sync with this.
 *
 * Data layout (docs/MULTI-TOKEN.md):
 *   public/data/<slug>/<feed>.json   — every project's feeds, same filenames
 *   public/data/<feed>.json          — "legacyRoot" projects only (TEL today):
 *                                      their pipelines still write the
 *                                      pre-multi-token root. The site serves
 *                                      them at /data/<slug>/ anyway.
 */
import fs from "node:fs";
import path from "node:path";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function loadRegistry(root = process.cwd()) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "config/projects.json"), "utf8"));
  const projects = raw.projects ?? [];
  return projects;
}

export function loadProjectConfig(slug, root = process.cwd()) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: ${slug}`);
  return JSON.parse(fs.readFileSync(path.join(root, "config/projects", `${slug}.json`), "utf8"));
}

/** Repo-relative directory holding a project's feeds. */
export function projectDataDir(slug, root = process.cwd()) {
  const cfg = loadProjectConfig(slug, root);
  return cfg?.data?.legacyRoot ? "public/data" : `public/data/${slug}`;
}

/** Slugs whose feeds still live at the public/data/ root. */
export function legacyRootSlugs(root = process.cwd()) {
  return loadRegistry(root)
    .map((p) => p.slug)
    .filter((slug) => loadProjectConfig(slug, root)?.data?.legacyRoot === true);
}
