import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { useCexBalanceHistory } from "@/hooks/useCexBalanceHistory";
import { feedAsOf, type FeedAsOf } from "@/hooks/useFeedAsOf";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { settledEntries } from "@/lib/flowFeeds";
import { flowWindow, formatFeedDate } from "@/lib/flowWindow";
import { pickWindowBaseline, settledEndMs } from "@/lib/settledEnd";
import { formatSignedCompact } from "@/lib/format";

/** "as of 2026-11-05 (block 123)", one block per chain; null without blocks. */
export const asOfBlockCaption = (asOf: FeedAsOf | null | undefined): string | null => {
  const entries = Object.entries(asOf?.blocks ?? {});
  if (!asOf || entries.length === 0) return null;
  const blocks = entries.length === 1
    ? `block ${entries[0][1]}`
    : entries.map(([chain, n]) => `${chain} block ${n}`).join(", ");
  return `as of ${asOf.date} (${blocks})`;
};

/**
 * Balance change (stock) beside measured netflow (Transfer logs) for the same
 * [end - N days, end) window, with their difference. Renders nothing unless
 * both feeds cover the window.
 */
export const ExchangeNetDiff = ({ rangeDays }: { rangeDays: number }) => {
  const flow = useExchangeFlow();
  const cex = useCexBalanceHistory();
  const { ticker } = useProjectCopy();

  const asOf = feedAsOf(flow.data) ?? feedAsOf(cex.data);
  const settledFlow = settledEntries(flow.data ?? []);
  const lastRow = settledFlow[settledFlow.length - 1] ?? cex.data?.[cex.data.length - 1];
  const endMs = settledEndMs({ asOf }, undefined, lastRow ? Date.parse(lastRow.date) : null);
  const blockCaption = asOfBlockCaption(asOf);
  const pick = cex.data ? pickWindowBaseline(cex.data, endMs, rangeDays, (e) => Date.parse(e.date)) : null;
  const flowRows = flowWindow(settledFlow, rangeDays, undefined, endMs).rows;
  if (!pick || flowRows.length === 0) return null;

  const balanceDelta = pick.end.total - pick.start.total;
  const measuredNet = flowRows.reduce((s, e) => s + (e.in ?? 0) - (e.out ?? 0), 0);
  const diff = balanceDelta - measuredNet;
  const fmt = (n: number) => `${formatSignedCompact(n)} ${ticker}`;

  return (
    <div className="premium-surface-card p-3 text-sm" data-testid="exchange-net-diff">
      <div className="text-xs text-muted-foreground font-semibold mb-2">
        Balance Δ vs measured netflow · {formatFeedDate(pick.startTs)} – {formatFeedDate(pick.endTs)}
        {pick.approximate ? " (nearest snapshot)" : ""}
      </div>
      {blockCaption ? (
        <div className="-mt-1 mb-2 text-xs text-muted-foreground font-mono" data-testid="exchange-net-diff-asof">{blockCaption}</div>
      ) : null}
      <div className="grid grid-cols-3 gap-2 tabular-nums">
        <div><div className="text-xs text-muted-foreground">Balance Δ</div><div className="font-semibold">{fmt(balanceDelta)}</div></div>
        <div><div className="text-xs text-muted-foreground">Measured netflow</div><div className="font-semibold">{fmt(measuredNet)}</div></div>
        <div><div className="text-xs text-muted-foreground">Difference</div><div className="font-semibold">{fmt(diff)}</div></div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The two differ when exchange wallet sets change (wallets added or relabelled) or when {ticker} moves between untracked exchange wallets; transfers between two tracked exchanges count in both flows.
      </p>
    </div>
  );
};
