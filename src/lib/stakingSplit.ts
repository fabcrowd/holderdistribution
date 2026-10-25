type Channel = { stakerCount: number; stakedTotal: number };
type SplitStats = { legacy?: Channel | null; v3?: Channel | null };

/** "Legacy X / v3 Y" sub-label, only when BOTH channels have stakers (TEL). */
export function stakingSplitSub(stats: SplitStats, field: "count" | "total", fmt: (n: number) => string): string | undefined {
  const { legacy, v3 } = stats;
  if (!legacy || !v3 || legacy.stakerCount <= 0 || v3.stakerCount <= 0) return undefined;
  return field === "count"
    ? `Legacy ${fmt(legacy.stakerCount)} / v3 ${fmt(v3.stakerCount)}`
    : `Legacy ${fmt(legacy.stakedTotal)} / v3 ${fmt(v3.stakedTotal)}`;
}
