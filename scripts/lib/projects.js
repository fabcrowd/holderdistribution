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

/** The registry's default project (TEL today). */
export function defaultProjectSlug(root = process.cwd()) {
  const registry = loadRegistry(root);
  return (registry.find((p) => p.default) ?? registry[0])?.slug ?? "tel";
}

/**
 * Pipeline `--project <slug>` selection. Accepts `--project slug` or
 * `--project=slug`; falls back to the HD_PROJECT env var (set once per job by
 * the workflows' `project` dispatch input), then to the registry default.
 * Returns the raw slug; resolveProject() validates it against the registry.
 */
export function parseProjectArg(argv = process.argv.slice(2), env = process.env, root = process.cwd()) {
  let slug;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--project needs a slug, e.g. --project tel");
      slug = next;
      i++;
    } else if (a.startsWith("--project=")) {
      slug = a.slice("--project=".length);
      if (!slug) throw new Error("--project needs a slug, e.g. --project=tel");
    }
  }
  if (slug === undefined) slug = (env?.HD_PROJECT ?? "").trim() || defaultProjectSlug(root);
  slug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: ${JSON.stringify(slug)}`);
  return slug;
}

/** Registry-checked project: { slug, config, dataDir, isDefault }. */
export function resolveProject(slug, root = process.cwd()) {
  const registry = loadRegistry(root);
  const entry = registry.find((p) => p.slug === slug);
  if (!entry) {
    throw new Error(`unknown project "${slug}" (config/projects.json has: ${registry.map((p) => p.slug).join(", ")})`);
  }
  return {
    slug,
    config: loadProjectConfig(slug, root),
    dataDir: projectDataDir(slug, root),
    isDefault: entry.default === true,
  };
}

/**
 * Entry point for refresh/generate scripts. Today's pipeline reads its token
 * addresses from config/chains.json and writes the legacy public/data/ root,
 * i.e. it can only produce a `data.legacyRoot` project (TEL). Any other slug is
 * refused up front so a run can never write one token's numbers under another
 * project's name. Porting a script = read tokens from `config` and write under
 * `dataDir`, then drop it from this guard (docs/MULTI-TOKEN.md "Pipeline").
 */
export function pipelineProject(script, { argv = process.argv.slice(2), env = process.env, root = process.cwd() } = {}) {
  const project = resolveProject(parseProjectArg(argv, env, root), root);
  if (project.config?.data?.legacyRoot !== true) {
    throw new Error(
      `${script}: project "${project.slug}" is not wired into the data pipeline yet ` +
        `(only legacyRoot projects are; see docs/MULTI-TOKEN.md "Pipeline").`,
    );
  }
  return project;
}

/** CLI wrapper: pipelineProject() that prints and exits 2 on a bad selection. */
export function selectPipelineProject(script) {
  try {
    const project = pipelineProject(script);
    console.error(`[${script}] project: ${project.slug} (${project.dataDir})`);
    return project;
  } catch (err) {
    console.error(`[${script}] ${err.message}`);
    process.exit(2);
  }
}
