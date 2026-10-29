/**
 * Which project a forensics-gate request is for, and where that project's
 * gated files live. Same shared format for every project (docs/MULTI-TOKEN.md
 * "Gated forensics"): the same keys (wallet-flows, disposition ledger,
 * association flows, wallet write-ups) are answered per project, and a
 * project with nothing gated yet gets `null` payloads (the UI shows an empty
 * panel), never another project's data.
 *
 * The registry is bundled into the function, so a newly registered project is
 * accepted without touching this file. LEGACY_ROOT_SLUGS is derived from the
 * registry's `legacyRoot` flag (a test keeps it equal to `data.legacyRoot` in
 * config/projects/<slug>.json).
 */
import registry from "../../config/projects.json";

type Entry = { slug: string; default?: boolean; legacyRoot?: boolean };

const ENTRIES = (registry as { projects: Entry[] }).projects;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const GATED_PROJECT_SLUGS: ReadonlySet<string> = new Set(ENTRIES.map((p) => p.slug).filter((s) => SLUG_RE.test(s)));
export const DEFAULT_GATED_PROJECT: string = ENTRIES.find((p) => p.default)?.slug ?? ENTRIES[0]?.slug ?? "tel";
/** Projects whose working files still live at the data/ root (TEL). */
export const LEGACY_ROOT_SLUGS: ReadonlySet<string> = new Set(ENTRIES.filter((p) => p.legacyRoot === true).map((p) => p.slug));

/**
 * Normalize a request's `project`. Missing = the default project (TEL), so old
 * clients keep working. Returns null for anything not in the registry.
 */
export function resolveGatedProject(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_GATED_PROJECT;
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  return GATED_PROJECT_SLUGS.has(slug) ? slug : null;
}

/** Repo path of a project's wallet-flows report (data/, never public/). */
export const walletFlowsRepoPath = (slug: string): string =>
  LEGACY_ROOT_SLUGS.has(slug) ? "data/forensics/wallet-flows.json" : `data/${slug}/forensics/wallet-flows.json`;
