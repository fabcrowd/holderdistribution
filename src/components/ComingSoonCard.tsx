type Props = {
  name: string;
  ticker: string;
  /** Cached logo path (public/tokens/). */
  image: string;
};

/**
 * Compact placeholder for a token that is not live yet. Not a link, and dashed
 * so it reads as "not live". Sits in the "Coming soon" group under the token grid.
 */
export const ComingSoonCard = ({ name, ticker, image }: Props) => (
  <div
    data-testid={`coming-soon-${ticker.toLowerCase()}`}
    className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-card py-2.5 pl-3 pr-4"
  >
    <img src={image} alt="" width={28} height={28} decoding="async" className="h-7 w-7 shrink-0 rounded-full grayscale opacity-60" />
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-muted-foreground">{name}</p>
      <p className="ha-num text-xs text-muted-foreground">{ticker}</p>
    </div>
  </div>
);

export default ComingSoonCard;
