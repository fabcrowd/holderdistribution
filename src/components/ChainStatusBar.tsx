import type { ReactNode } from "react";
import { ExternalLink, Info } from "lucide-react";
import { useChainStatus } from "@/hooks/useChainStatus";
import { formatRelativeAge } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const timeAgo = (iso: string): string => formatRelativeAge(iso) ?? "unknown";

export const ChainStatusBar = () => {
  const { data } = useChainStatus();
  if (!data || data.chains.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {data.generatedAt && (
        <span className="tabular-nums">
          Updated {timeAgo(data.generatedAt)}
        </span>
      )}
      <span className="hidden sm:inline text-muted-foreground/30">·</span>
      {data.chains.map((chain) => (
        <a
          key={chain.key}
          href={chain.tokenUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 xl:min-h-0 items-center gap-1 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary transition-colors"
        >
          {chain.label} RPC
          {chain.stale && <span className="text-amber-700 dark:text-amber-400 no-underline">(stale)</span>}
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
          <span className="sr-only">(opens in new tab)</span>
        </a>
      ))}
    </div>
  );
};

type CompactProps = {
  /** e.g. "Snapshot generated Oct 29, 2026, 8:00 AM" */
  snapshotLabel: string;
  /** e.g. "Source: On-chain RPC" */
  sourceLabel: string;
  /** Extra controls (admin refresh) shown in the popover. */
  children?: ReactNode;
  className?: string;
};

/**
 * Phone-sized provenance: one "Updated 15h ago (i)" line. The popover holds the
 * snapshot time, source and the RPC links, so nothing is dropped. A stale RPC
 * stays visible on the line itself.
 */
export const CompactProvenance = ({ snapshotLabel, sourceLabel, children, className = "" }: CompactProps) => {
  const { data } = useChainStatus();
  const anyStale = !!data?.chains.some((c) => c.stale);
  const summary = data?.generatedAt ? `Updated ${timeAgo(data.generatedAt)}` : "Data source";
  return (
    <div className={`flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground ${className}`} data-testid="compact-provenance">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${summary}. Snapshot, source and RPC links`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {summary}
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto max-w-xs space-y-1 p-3 text-sm">
          <p>{snapshotLabel}</p>
          <p>{sourceLabel}</p>
          {data && data.chains.length > 0 && (
            <div className="flex flex-col">
              {data.chains.map((chain) => (
                <a
                  key={chain.key}
                  href={chain.tokenUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-primary"
                >
                  {chain.label} RPC
                  {chain.stale && <span className="text-amber-700 dark:text-amber-400 no-underline">(stale)</span>}
                  <ExternalLink aria-hidden="true" className="h-3 w-3" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              ))}
            </div>
          )}
          {children}
        </PopoverContent>
      </Popover>
      {anyStale && <span className="text-amber-700 dark:text-amber-400">RPC data stale</span>}
    </div>
  );
};
