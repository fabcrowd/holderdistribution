import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RANGE_OPTIONS, rangeLabel } from "@/lib/timeRange";

type TimeRangeDropdownProps = {
  value: number;
  onChange: (days: number) => void;
  className?: string;
  /** Defaults to the full RANGE_OPTIONS list. Pass a filtered subset to hide
   *  ranges the archive can't actually answer yet (e.g. "1Y" before the
   *  archive is a year old) — see Holders.tsx. */
  options?: typeof RANGE_OPTIONS;
};

/**
 * Page-wide timeframe control, shown once in the sticky bar. Every section
 * reads the same `rangeDays` state — sections themselves only display a
 * "Showing: {label}" note, so changing the period never requires scrolling.
 */
export const TimeRangeDropdown = ({ value, onChange, className, options = RANGE_OPTIONS }: TimeRangeDropdownProps) => {
  const label = rangeLabel(value, options);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger
        aria-label={`Time range: ${label}`}
        className={`h-8 max-xl:h-11 w-auto gap-1.5 rounded-md border-border bg-card px-2.5 text-[13px] font-medium text-foreground hover:border-border-strong focus:ring-ring ${className ?? ""}`}
      >
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.label} value={String(option.days)} className="text-sm">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
