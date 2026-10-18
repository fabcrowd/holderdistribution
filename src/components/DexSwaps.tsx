import { useMemo } from "react";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { useTierOutflows, outflowsKeyFor } from "@/hooks/useTierOutflows";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { ytdDays } from "@/lib/timeRange";

type DexSwapsProps = {
  rangeDays: number;
};

const formatCompactTEL = (value: number) => {
  const a = Math.abs(value);
  if (a >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return `${Math.round(value)}`;
};

/**
 * On-chain DEX buy/sell + LP activity + a plain-language explainer of how to
 * read where a holder's outgoing TEL went. Lives in the distribution section
 * because it's about market selling vs. simply moving TEL — not exchange
 * custody (which is the CEX Flow section).
 */
export const DexSwaps = ({ rangeDays }: DexSwapsProps) => {
  const { data: entries } = useExchangeFlow();
  const { data: outflows } = useTierOutflows();
  const ytd = ytdDays();

  const view = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    const latestTs = Date.parse(entries[entries.length - 1].date);
    const cutoff = latestTs - rangeDays * 86400000;
    const inRange = entries.filter((e) => Date.parse(e.date) >= cutoff);
    if (inRange.length === 0) return null;
    const dexSold = inRange.reduce((s, e) => s + (e.dexIn ?? 0), 0);
    const dexBought = inRange.reduce((s, e) => s + (e.dexOut ?? 0), 0);
    const hasDex = inRange.some((e) => e.dexIn != null || e.dexOut != null);
    // Buy-positive: + when more TEL was bought (out of pools) than sold (in).
    return { dexSold, dexBought, dexNet: dexBought - dexSold, hasDex };
  }, [entries, rangeDays]);

  const lpView = useMemo(() => {
    const key = outflowsKeyFor(rangeDays, ytd);
    const tiers = outflows?.ranges?.[key]?.tiers;
    if (!tiers) return null;
    let added = 0;
    let removed = 0;
    let hasLp = false;
    for (const cell of Object.values(tiers)) {
      const outLp = cell.dexLp ?? 0;
      const inLp = cell.inflows?.dexLp ?? 0;
      if (outLp > 0 || inLp > 0) hasLp = true;
      added += outLp;
      removed += inLp;
    }
    if (!hasLp) return null;
    return { added, removed, net: removed - added };
  }, [outflows, rangeDays, ytd]);

  return (
    <div className="space-y-4">
      {view?.hasDex && (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">DEX Swaps</div>
            <MethodologyInfo section="dexSwaps" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Sold on DEX</div>
              <div className="text-xl font-bold text-foreground">{formatCompactTEL(view.dexSold)} TEL</div>
              <div className="text-xs text-muted-foreground mt-0.5">swapped for another coin</div>
            </div>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Bought on DEX</div>
              <div className="text-xl font-bold text-foreground">{formatCompactTEL(view.dexBought)} TEL</div>
              <div className="text-xs text-muted-foreground mt-0.5">swapped in from another coin</div>
            </div>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Net DEX</div>
              <div className={`text-xl font-bold ${view.dexNet >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                {view.dexNet >= 0 ? "+" : "−"}{formatCompactTEL(Math.abs(view.dexNet))} TEL
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {view.dexNet >= 0 ? "net bought from market" : "net sold to market"}
              </div>
            </div>
          </div>
        </div>
      )}

      {lpView && (
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">LP Activity</div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Added to LP</div>
              <div className="text-xl font-bold text-foreground">{formatCompactTEL(lpView.added)} TEL</div>
              <div className="text-xs text-muted-foreground mt-0.5">deposited into pools</div>
            </div>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Unstaked from LP</div>
              <div className="text-xl font-bold text-foreground">{formatCompactTEL(lpView.removed)} TEL</div>
              <div className="text-xs text-muted-foreground mt-0.5">withdrawn back to wallets</div>
            </div>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Net LP</div>
              <div className="text-xl font-bold text-foreground">
                {lpView.net >= 0 ? "+" : "−"}{formatCompactTEL(Math.abs(lpView.net))} TEL
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {lpView.net >= 0 ? "net withdrawn to wallets" : "net deposited into pools"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plain-language explainer: how to read where outgoing TEL went. */}
      <div className="rounded-2xl border border-border/50 bg-muted/20 p-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-3 text-center">
          Reading the outflows — a wallet&apos;s balance can fall four ways
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div>
            <div className="font-semibold text-foreground flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground" /> Moved to wallets
            </div>
            <div className="text-muted-foreground mt-1">
              Sent to another wallet the holder controls (or a gift). The TEL is still held on-chain — not sold, just relocated or split.
            </div>
          </div>
          <div>
            <div className="font-semibold text-foreground flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> Sold on DEX
            </div>
            <div className="text-muted-foreground mt-1">
              Swapped into a liquidity pool for another coin — a realized on-chain sale, visible in the same transaction.
            </div>
          </div>
          <div>
            <div className="font-semibold text-foreground flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-yellow-500" /> Added to LP
            </div>
            <div className="text-muted-foreground mt-1">
              Deposited into a pool for liquidity — still economically owned via LP tokens, not a sale.
            </div>
          </div>
          <div>
            <div className="font-semibold text-foreground flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" /> To exchanges
            </div>
            <div className="text-muted-foreground mt-1">
              Deposited to an exchange wallet — potential sell pressure, but trading is off-chain so the sale itself isn&apos;t visible here.
            </div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground/80 mt-3 text-center">
          Hover a tier above to see how much of its outgoing TEL went each way.
        </div>
      </div>
    </div>
  );
};
