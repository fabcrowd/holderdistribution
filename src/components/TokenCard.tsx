import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { percentWidth, type CardStats } from "@/lib/landingStats";
import type { CardConcentration, CardTrend } from "@/lib/cardTrend";
import { CardSparkline } from "@/components/CardSparkline";
import { tokenPath } from "@/lib/tokenRoutes";
import { RETAIL_WALLETS_LABEL } from "@/lib/holderCounts";

type Props = {
  slug: string;
  name: string;
  ticker: string;
  /** Cached image path (public/tokens/). */
  image?: string;
  /** null while the feed is loading. */
  stats: CardStats | null;
  /** Top-10 / top-100 share of retail-held supply; null while loading. */
  concentration?: CardConcentration | null;
  /** 30-day retail-wallet series; null when the feed is missing or has <2 rows. */
  trend?: CardTrend | null;
  /** Placeholder text shown when `trend` is null (e.g. history cut by a methodology change). */
  trendNote?: string;
  /** True while holders-history.json is loading. */
  trendLoading?: boolean;
};

const CARD_CLASS =
  "group relative flex h-full flex-col gap-5 rounded-lg border border-border bg-card p-5 transition-[border-color,box-shadow,transform] duration-200 hover:border-primary/60 hover:shadow-pop motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6";

const SkeletonValue = ({ className }: { className: string }) => (
  <dd data-loading="true" aria-label="Loading" className={`animate-pulse rounded bg-muted/70 ${className}`} />
);

/** 4px track; the fill is sized from the stat's percent and omitted when it is not a number. */
const Meter = ({ value, fillClass }: { value: string | null; fillClass: string }) => {
  const width = percentWidth(value);
  return (
    <span aria-hidden="true" className="mt-1.5 block h-1 overflow-hidden rounded-pill bg-muted">
      {width !== null && <span className={`block h-full rounded-pill ${fillClass}`} style={{ width: `${width}%` }} />}
    </span>
  );
};

const PrimaryStat = ({ label, value }: { label: string; value: string | null }) => (
  <div className="flex flex-col gap-1">
    <dt className="text-[13px] text-muted-foreground">{label}</dt>
    {value === null ? (
      <SkeletonValue className="h-7 w-28" />
    ) : (
      <dd className="ha-num text-[28px] font-medium leading-none text-foreground">{value}</dd>
    )}
  </div>
);

const SecondaryStat = ({
  label,
  fullLabel,
  value,
  fillClass,
}: {
  label: string;
  fullLabel: string;
  value: string | null;
  fillClass: string;
}) => (
  <div className="flex min-w-0 flex-col">
    <dt title={fullLabel} className="truncate text-xs text-muted-foreground">
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{fullLabel}</span>
    </dt>
    {value === null ? (
      <SkeletonValue className="mt-1 h-4 w-12" />
    ) : (
      <dd className="ha-num mt-1 text-sm font-medium text-foreground">{value}</dd>
    )}
    <Meter value={value} fillClass={fillClass} />
  </div>
);

/** One landing card. The whole card is a single link to the token's terminal. */
export const TokenCard = ({ slug, name, ticker, image, stats, concentration = null, trendLoading = false, trend = null, trendNote }: Props) => (
  <Link to={tokenPath(slug)} data-testid={`token-card-${slug}`} className={CARD_CLASS}>
    <div className="flex items-center gap-3">
      {image && <img src={image} alt="" width={40} height={40} decoding="async" className="h-10 w-10 shrink-0 rounded-full" />}
      <div className="min-w-0">
        <h3 className="truncate font-display text-lg font-bold text-foreground">{name}</h3>
        <p className="ha-num text-[13px] font-medium text-muted-foreground">{ticker}</p>
      </div>
      <span
        aria-hidden="true"
        className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground"
      >
        <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
      </span>
    </div>
    <div className="flex flex-col gap-4">
      <dl>
        <PrimaryStat label={RETAIL_WALLETS_LABEL} value={stats ? stats.holders : null} />
      </dl>
      <dl className="grid grid-cols-3 gap-3">
        <SecondaryStat label="Retail share" fullLabel="Retail share of supply" value={stats ? stats.retailShare : null} fillClass="bg-primary" />
        <SecondaryStat
          label="Top 10"
          fullLabel="Top 10 holders"
          value={concentration ? concentration.top10 : null}
          fillClass="bg-foreground/60"
        />
        <SecondaryStat
          label="Top 100"
          fullLabel="Top 100 holders"
          value={concentration ? concentration.top100 : null}
          fillClass="bg-foreground/60"
        />
      </dl>
    </div>
    <div className="mt-auto">
      {trendLoading ? (
        <div data-loading="true" aria-label="Loading holder trend" className="h-[72px] rounded-md bg-muted/70 animate-pulse" />
      ) : (
        <CardSparkline name={name} trend={trend} note={trendNote} />
      )}
    </div>
  </Link>
);

export default TokenCard;
