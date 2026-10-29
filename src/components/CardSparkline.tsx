import { useId } from "react";
import type { CardTrend } from "@/lib/cardTrend";
import { MIN_FONT_PX, TYPE_PX } from "@/lib/terminalLayout";

const W = 240;
const H = 40;
const PAD = 3;

const int = new Intl.NumberFormat("en-US");
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Accessible summary read by screen readers (the SVG itself is a single image). */
export const trendLabel = (name: string, t: CardTrend): string =>
  `${name} retail wallets, ${dateFmt.format(t.first.t)} to ${dateFmt.format(t.last.t)}: ${int.format(t.first.v)} to ${int.format(t.last.v)}.`;

/**
 * Tiny single-series line. Stroke/fill use theme tokens so it works in light
 * and dark; y-domain is padded min..max of the window (a count, so it need not
 * start at zero); caption text uses the terminal caption size (>= 12px).
 * `trend === null` renders a same-height placeholder so cards stay aligned.
 */
export const CardSparkline = ({ name, trend }: { name: string; trend: CardTrend | null }) => {
  const gid = useId();
  if (!trend) {
    return (
      <div data-testid="card-sparkline-empty" className="flex h-[72px] flex-col justify-center rounded-md bg-muted/40 px-3">
        <p style={{ fontSize: TYPE_PX.caption }} className="text-muted-foreground">
          Holder trend appears once 2+ days of history exist.
        </p>
      </div>
    );
  }
  const { points, first, last, spanDays } = trend;
  const t0 = first.t;
  const tSpan = Math.max(last.t - t0, 1);
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const vSpan = hi - lo;
  const x = (t: number) => PAD + ((t - t0) / tSpan) * (W - 2 * PAD);
  const y = (v: number) => (vSpan === 0 ? H / 2 : H - PAD - ((v - lo) / vSpan) * (H - 2 * PAD));
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${x(last.t).toFixed(1)},${H}L${x(first.t).toFixed(1)},${H}Z`;
  const delta = last.v - first.v;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return (
    <div data-testid="card-sparkline" className="flex h-[72px] flex-col justify-between">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={trendLabel(name, trend)} preserveAspectRatio="none" className="h-10 w-full">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="hsl(var(--primary))" stopOpacity="0.25" />
            <stop offset="1" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x(last.t)} cy={y(last.v)} r="2.5" fill="hsl(var(--primary))" />
      </svg>
      <p style={{ fontSize: Math.max(TYPE_PX.caption, MIN_FONT_PX) }} className="flex justify-between text-muted-foreground">
        <span>{spanDays} day{spanDays === 1 ? "" : "s"} · retail wallets</span>
        <span className="font-mono tabular-nums">
          {sign}
          {int.format(Math.abs(delta))}
        </span>
      </p>
    </div>
  );
};
