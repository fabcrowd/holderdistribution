import type { ReactNode } from "react";
import { InfoTooltip } from "@/components/InfoTooltip";
import { NEGATIVE_TEXT, POSITIVE_TEXT, type Tone } from "./palette";

/** Grows the (i) trigger to a 44px hit area below xl; desktop keeps the 24px icon. */
export const INFO_HIT_44 = "max-xl:before:-inset-2.5";

export type Stat = {
  key: string;
  /** Short label (12px); the explanation lives in `tip`. */
  label: string;
  tip: string;
  value: ReactNode;
  tone?: Tone;
};

const toneColor = (tone?: Tone): string | undefined =>
  tone === "positive" ? POSITIVE_TEXT : tone === "negative" ? NEGATIVE_TEXT : undefined;

type StatStripProps = {
  stats: readonly Stat[];
  /** Tier name shown once as a chip; omit for the all-tiers view. Not shown when stacked (the rail title names the tier). */
  prefix?: string | null;
  /** Always one stat per row (the narrow terminal rail). Otherwise 3 columns from sm up. */
  stacked?: boolean;
  testId?: string;
};

/** One slim row of headline figures: label + (i) tooltip above a tabular value. */
export const StatStrip = ({ stats, prefix, stacked = false, testId }: StatStripProps) => (
  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3" data-testid={testId}>
    {prefix && !stacked && (
      <span className="inline-flex w-fit shrink-0 items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground" data-testid="tier-strip-prefix">
        {prefix}
      </span>
    )}
    <dl className={`grid min-w-0 flex-1 grid-cols-1 divide-y divide-border/60 rounded-lg border border-border/60 ${stacked ? "" : "sm:grid-cols-3 sm:divide-x sm:divide-y-0"}`}>
      {stats.map((s) => (
        <div key={s.key} className={`flex min-h-11 items-center justify-between gap-2 px-3 py-1 ${stacked ? "" : "sm:flex-col sm:items-start sm:justify-center sm:gap-0"}`}>
          <dt className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            {s.label}
            <InfoTooltip text={s.tip} label={`${s.label}: what this means`} className={INFO_HIT_44} />
          </dt>
          <dd className={`whitespace-nowrap font-bold tabular-nums leading-tight ${stacked ? "text-base" : "text-lg"}`} style={{ color: toneColor(s.tone) }}>
            {s.value}
          </dd>
        </div>
      ))}
    </dl>
  </div>
);
