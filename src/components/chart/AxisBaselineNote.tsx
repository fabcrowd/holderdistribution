import { formatCompact } from "@/lib/format";
import { InfoTip } from "@/components/InfoTip";

type Props = {
  /** `YAxisScale.baseline`: the value at the bottom of the axis, or null when it is zero. */
  baseline: number | null;
  format?: (n: number) => string;
  /** Which axis the note describes (a dual-axis chart has one per side). */
  side?: "left" | "right";
};

/**
 * Small note shown when a y-axis does not start at zero, so a zoomed-in line is
 * never mistaken for a zero-based one. Rendered in ZoomFrame's header row (via
 * its `notes` prop), outside the plot, so it never covers data.
 */
export const AxisBaselineNote = ({ baseline, format = (n) => formatCompact(n, 2), side = "left" }: Props) => {
  if (baseline == null) return null;
  const name = side === "right" ? "Right axis" : "Axis";
  const value = format(baseline);
  return (
    <p className="text-[11px] leading-4 text-muted-foreground" data-testid="axis-baseline-note" data-side={side}>
      <span className="max-sm:hidden">
        {name} starts at {value}
      </span>
      <span className="inline-flex items-center gap-0.5 sm:hidden">
        {name} from {value}
        <InfoTip
          content={`${name} starts at ${value}, not zero, so the chart is zoomed in on the range shown.`}
          label={`About the ${name.toLowerCase()} start`}
          side="bottom"
          align="start"
          className="h-4 w-4"
          iconClassName="h-3 w-3"
        />
      </span>
    </p>
  );
};
