import { Link } from "react-router-dom";
import type { CardStats } from "@/lib/landingStats";
import { tokenPath } from "@/lib/tokenRoutes";

type Props = {
  slug: string;
  name: string;
  ticker: string;
  /** Cached image path (public/tokens/). */
  image?: string;
  /** null while the feed is loading. */
  stats: CardStats | null;
};

const Stat = ({ label, value }: { label: string; value: string | null }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    {value === null ? (
      <dd data-loading="true" className="h-5 w-16 rounded bg-muted/70 animate-pulse" aria-label="Loading" />
    ) : (
      <dd className="font-mono text-base font-semibold tabular-nums text-foreground">{value}</dd>
    )}
  </div>
);

/** One landing card. The whole card is a single link to the token's terminal. */
export const TokenCard = ({ slug, name, ticker, image, stats }: Props) => (
  <Link
    to={tokenPath(slug)}
    data-testid={`token-card-${slug}`}
    className="group flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <div className="flex items-center gap-3">
      {image && <img src={image} alt="" width={40} height={40} decoding="async" className="h-10 w-10 shrink-0 rounded-full" />}
      <div className="min-w-0">
        <h2 className="truncate text-lg font-bold text-foreground group-hover:text-primary">{name}</h2>
        <p className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">{ticker}</p>
      </div>
    </div>
    <dl className="grid grid-cols-2 gap-3">
      <Stat label="Holders" value={stats ? stats.holders : null} />
      <Stat label="Retail share of supply" value={stats ? stats.retailShare : null} />
    </dl>
  </Link>
);

export default TokenCard;
