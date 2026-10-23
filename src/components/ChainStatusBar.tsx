import { ExternalLink } from "lucide-react";
import { useChainStatus } from "@/hooks/useChainStatus";
import { formatRelativeAge } from "@/lib/format";

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
          className="inline-flex items-center gap-1 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary transition-colors"
        >
          {chain.label} RPC
          <ExternalLink className="h-3 w-3" />
        </a>
      ))}
    </div>
  );
};
