import { afterEach, describe, expect, it, vi } from "vitest";

// Each feed hook is a thin useQuery wrapper; capture its options and run the
// queryFn directly so we can assert error behaviour without a DOM.
vi.mock("@tanstack/react-query", () => ({ useQuery: (opts: unknown) => opts }));
// Called as plain functions (no React renderer), so stub the active project.
vi.mock("@/hooks/useProject", async () => {
  const { getProject } = await import("@/lib/projects");
  return { useProject: () => ({ slug: "tel", project: getProject("tel") }) };
});

import { useClassificationChangelog } from "./useClassificationChangelog";
import { useTreasuryHistory } from "./useTreasuryHistory";
import { useHolderTransitions } from "./useHolderTransitions";
import { useCexBalanceHistory } from "./useCexBalanceHistory";
import { useExchangeFlow } from "./useExchangeFlow";
import { useSupplyReconciliation } from "./useSupplyReconciliation";
import { useTierOutflows } from "./useTierOutflows";
import { useChainStatus } from "./useChainStatus";
import { FeedError } from "@/lib/fetchJson";

type Opts = { queryFn: () => Promise<unknown> };
const hooks: Array<[string, () => unknown]> = [
  ["classification-changelog", useClassificationChangelog],
  ["treasury-history", useTreasuryHistory],
  ["holder-transitions", useHolderTransitions],
  ["cex-balance-history", useCexBalanceHistory],
  ["exchange-flow", useExchangeFlow],
  ["supply-reconciliation", useSupplyReconciliation],
  ["tier-outflows", useTierOutflows],
  ["chain-status", useChainStatus],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feed hooks are per project", () => {
  it.each(hooks)("%s keys its query and URL by the active slug", async (_name, hook) => {
    const f = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", f);
    const opts = hook() as Opts & { queryKey: unknown[] };
    expect(opts.queryKey.at(-1)).toBe("tel");
    await opts.queryFn().catch(() => {});
    expect(String((f.mock.calls[0] as unknown[])[0])).toMatch(/^\/data\/tel\/[a-z-]+\.json$/);
  });
});

describe("feed hooks surface HTTP failures as query errors", () => {
  it.each(hooks)("%s throws on a non-2xx response (so Retry can recover)", async (_name, hook) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { queryFn } = hook() as Opts;
    await expect(queryFn()).rejects.toBeInstanceOf(FeedError);
  });

  it("a missing tier-outflows or exchange-flow feed is an empty payload, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const outflows = useTierOutflows() as unknown as Opts;
    await expect(outflows.queryFn()).resolves.toEqual({ ranges: {}, complete: false });
    const flows = useExchangeFlow() as unknown as Opts;
    await expect(flows.queryFn()).resolves.toEqual([]);
  });

  it("chain-status reads the small chain-status.json, never the 5 MB checkpoint", async () => {
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ generatedAt: "2026-10-23T00:00:00Z", chains: { ethereum: { lastBlock: 1 }, polygon: { lastBlock: 2 }, base: { lastBlock: 3 } } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", f);
    const { queryFn } = useChainStatus() as unknown as Opts;
    const out = (await queryFn()) as { chains: Array<{ key: string; lastBlock: number }> };
    expect(String((f.mock.calls[0] as unknown[])[0])).toMatch(/\/data\/tel\/chain-status\.json$/);
    expect(out.chains.map((c) => [c.key, c.lastBlock])).toEqual([["ethereum", 1], ["polygon", 2], ["base", 3]]);
  });
});
