import { RANGE_OPTIONS } from "@/lib/timeRange";

/**
 * Small "Showing: 30D" note for a section/tile header. The single control
 * lives in the sticky bar; this just confirms what period the numbers below
 * reflect, since a page-wide selector isn't visually next to every section.
 */
export const ActiveRangeNote = ({ rangeDays, className }: { rangeDays: number; className?: string }) => {
  const label = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${className ?? ""}`}
    >
      Showing {label}
    </span>
  );
};
