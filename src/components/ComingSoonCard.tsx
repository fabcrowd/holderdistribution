import { RETAIL_WALLETS_LABEL } from "@/lib/holderCounts";

type Props = {
  name: string;
  ticker: string;
  /** Cached logo path (public/tokens/). */
  image: string;
};

const PLACEHOLDER_STATS = [
  RETAIL_WALLETS_LABEL,
  "Retail share of supply",
  "Top 10 holders",
  "Top 100 holders",
] as const;

/**
 * Placeholder for a token that is not mapped yet. Same footprint as TokenCard
 * but not a link, and dashed so it reads as "not live". The logo and text are
 * greyed and faded to 50%; the border stays at full strength.
 */
export const ComingSoonCard = ({ name, ticker, image }: Props) => (
  <div
    data-testid={`coming-soon-${ticker.toLowerCase()}`}
    className="h-full rounded-lg border border-dashed border-border bg-card p-6"
  >
    <div className="flex h-full flex-col gap-4 opacity-50">
      <div className="flex items-center gap-3">
        <img src={image} alt="" width={40} height={40} decoding="async" className="h-10 w-10 shrink-0 rounded-full grayscale" />
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold text-muted-foreground">{name}</h2>
          <p className="font-mono text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{ticker}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        {PLACEHOLDER_STATS.map((label) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-[13px] text-muted-foreground">{label}</dt>
            <dd className="font-mono text-base font-semibold tabular-nums text-muted-foreground">—</dd>
          </div>
        ))}
      </dl>
      <p className="mt-auto inline-flex w-fit items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
        Coming soon
      </p>
    </div>
  </div>
);

export default ComingSoonCard;
