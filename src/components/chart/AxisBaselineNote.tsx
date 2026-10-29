import { formatCompact } from "@/lib/format";

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
  return (
    <p className="text-[11px] leading-4 text-muted-foreground" data-testid="axis-baseline-note" data-side={side}>
      {side === "right" ? "Right axis" : "Axis"} starts at {format(baseline)}
    </p>
  );
};
