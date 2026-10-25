/**
 * Source of the gated Wallet flows report, per project.
 *
 * TEL's report lives at data/forensics/wallet-flows.json; any other project's at
 * data/<slug>/forensics/wallet-flows.json (walletFlowsRepoPath). Both are outside
 * public/, so they are never in dist/ or the client bundle. esbuild inlines TEL's
 * file into the gate function at build time (the "bundled" copy). When
 * LIVE_DATA_GITHUB_TOKEN is set (the same read-only token the live-data function
 * uses), the gate prefers the latest copy committed to the repo, so a regenerated
 * report shows up without a deploy. Other projects have no bundled copy: without
 * the token, or before their first report, they get `report: null` ("none").
 * Cached in memory for an hour, per project.
 */
import bundledReport from "../../data/forensics/wallet-flows.json";
import { DEFAULT_GATED_PROJECT, LEGACY_ROOT_SLUGS, walletFlowsRepoPath } from "./gatedProjects.ts";

type Env = Record<string, string | undefined>;
type Report = { version?: number; generated?: string; knownWallets?: unknown[] } & Record<string, unknown>;
export type WalletFlowsSource = "github" | "bundled" | "none";
type Result = { report: Report | null; source: WalletFlowsSource };

const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 6000;

const cache = new Map<string, { at: number } & Result>();

const isReport = (r: unknown): r is Report =>
  !!r && typeof r === "object" && (r as Report).version === 1 && Array.isArray((r as Report).knownWallets);

const newer = (a: Report, b: Report | null) => !b || Date.parse(a.generated ?? "") >= Date.parse(b.generated ?? "");

export function __resetWalletFlowsCache() {
  cache.clear();
}

export async function loadWalletFlows(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  slug: string = DEFAULT_GATED_PROJECT,
): Promise<Result> {
  const bundled = LEGACY_ROOT_SLUGS.has(slug) ? (bundledReport as Report) : null;
  const hit = cache.get(slug);
  if (hit && now - hit.at < CACHE_MS) return { report: hit.report, source: hit.source };
  const token = env.LIVE_DATA_GITHUB_TOKEN?.trim();
  let result: Result = bundled ? { report: bundled, source: "bundled" } : { report: null, source: "none" };
  if (token) {
    const repo = env.LIVE_DATA_REPO?.trim() || "fabcrowd/holderdistribution";
    const ref = env.LIVE_DATA_REF?.trim() || "main";
    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${repo}/contents/${walletFlowsRepoPath(slug)}?ref=${encodeURIComponent(ref)}`,
        {
          headers: {
            Accept: "application/vnd.github.raw+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "holderdistribution-forensics-gate",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (res.ok) {
        const remote = (await res.json()) as unknown;
        if (isReport(remote) && newer(remote, bundled)) result = { report: remote, source: "github" };
      }
    } catch {
      /* bundled copy (TEL) or none */
    }
  }
  cache.set(slug, { at: now, ...result });
  return result;
}
