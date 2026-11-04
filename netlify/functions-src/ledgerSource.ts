/**
 * Source of the gated developer-wallet ledger reports, per project:
 *   "project-ledger" -> data/<slug>/ledger/ledger.json        (scripts/build-ledger.js)
 *   "bot-proceeds"   -> data/<slug>/ledger/bot-proceeds.json  (scripts/trace-bot-proceeds.js)
 * Outside public/, never bundled: read from the repo with LIVE_DATA_GITHUB_TOKEN
 * (same read-only token as walletFlowsSource.ts), cached an hour per project+file.
 * No token or no file yet -> { report: null, source: "none" }. See docs/LEDGER.md.
 */
import { ledgerRepoPath, type LedgerFile } from "./gatedProjects.ts";

type Env = Record<string, string | undefined>;
type Report = { version?: number; slug?: string; generated?: string } & Record<string, unknown>;
export type LedgerSource = "github" | "none";
type Result = { report: Report | null; source: LedgerSource };

export const PROJECT_LEDGER_KEY = "project-ledger";
export const BOT_PROCEEDS_KEY = "bot-proceeds";
export const LEDGER_KEYS: Record<string, LedgerFile> = { [PROJECT_LEDGER_KEY]: "ledger.json", [BOT_PROCEEDS_KEY]: "bot-proceeds.json" };

const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 6000;
const cache = new Map<string, { at: number } & Result>();

export function __resetLedgerCache() {
  cache.clear();
}

/** A report must be version 1 and name the project it was requested for (never another project's file). */
const isReport = (r: unknown, slug: string): r is Report =>
  !!r && typeof r === "object" && (r as Report).version === 1 && (r as Report).slug === slug;

export async function loadLedgerFile(
  slug: string,
  file: LedgerFile,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<Result> {
  const k = `${slug}/${file}`;
  const hit = cache.get(k);
  if (hit && now - hit.at < CACHE_MS) return { report: hit.report, source: hit.source };
  let result: Result = { report: null, source: "none" };
  const token = env.LIVE_DATA_GITHUB_TOKEN?.trim();
  if (token) {
    const repo = env.LIVE_DATA_REPO?.trim() || "fabcrowd/holderdistribution";
    const ref = env.LIVE_DATA_REF?.trim() || "main";
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${ledgerRepoPath(slug, file)}?ref=${encodeURIComponent(ref)}`, {
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
        if (isReport(remote, slug)) result = { report: remote, source: "github" };
      }
    } catch {
      /* none */
    }
  }
  cache.set(k, { at: now, ...result });
  return result;
}
