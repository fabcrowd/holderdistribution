/**
 * Source of the gated Wallet flows report.
 *
 * The report lives at data/forensics/wallet-flows.json — outside public/, so it is
 * never in dist/ or the client bundle. esbuild inlines it into the gate function at
 * build time (the "bundled" copy). When LIVE_DATA_GITHUB_TOKEN is set (the same
 * read-only token the live-data function uses), the gate prefers the latest copy
 * committed to the repo, so a regenerated report shows up without a deploy. Any
 * GitHub problem falls back to the bundled copy. Cached in memory for an hour.
 */
import bundledReport from "../../data/forensics/wallet-flows.json";

type Env = Record<string, string | undefined>;
type Report = { version?: number; generated?: string; knownWallets?: unknown[] } & Record<string, unknown>;

const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 6000;
const PATH = "data/forensics/wallet-flows.json";

let cache: { at: number; report: Report; source: "github" | "bundled" } | null = null;

const isReport = (r: unknown): r is Report =>
  !!r && typeof r === "object" && (r as Report).version === 1 && Array.isArray((r as Report).knownWallets);

const newer = (a: Report, b: Report) => Date.parse(a.generated ?? "") >= Date.parse(b.generated ?? "");

export function __resetWalletFlowsCache() {
  cache = null;
}

export async function loadWalletFlows(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ report: Report; source: "github" | "bundled" }> {
  const bundled = bundledReport as Report;
  if (cache && now - cache.at < CACHE_MS) return cache;
  const token = env.LIVE_DATA_GITHUB_TOKEN?.trim();
  let result: { report: Report; source: "github" | "bundled" } = { report: bundled, source: "bundled" };
  if (token) {
    const repo = env.LIVE_DATA_REPO?.trim() || "fabcrowd/holderdistribution";
    const ref = env.LIVE_DATA_REF?.trim() || "main";
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${PATH}?ref=${encodeURIComponent(ref)}`, {
        headers: {
          Accept: "application/vnd.github.raw+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "holderdistribution-forensics-gate",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const remote = (await res.json()) as unknown;
        if (isReport(remote) && newer(remote, bundled)) result = { report: remote, source: "github" };
      }
    } catch {
      /* bundled copy */
    }
  }
  cache = { at: now, ...result };
  return result;
}
