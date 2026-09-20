import { ExternalLink } from "lucide-react";
import { useChainStatus } from "@/hooks/useChainStatus";

const timeAgo = (iso: string): string => {
  const diff = Date.now() - Date.parse(iso);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
};

export const ChainStatusBar = () => {
  const { data } = useChainStatus();
  if (!data || data.chains.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground/60">
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
          className="inline-flex items-center gap-1 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary transition-colors"
        >
          {chain.label} RPC
          <ExternalLink className="h-3 w-3" />
        </a>
      ))}
    </div>
  );
};
