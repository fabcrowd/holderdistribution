import { formatCompact } from "@/lib/format";

type Props = {
  /** `YAxisScale.baseline`: the value at the bottom of the axis, or null when it is zero. */
  baseline: number | null;
  format?: (n: number) => string;
  /** Which axis the note describes (a dual-axis chart has one per side). */
  side?: "left" | "right";
};

/**
 * Small in-plot note shown when a y-axis does not start at zero, so a zoomed-in
 * line is never mistaken for a zero-based one. Render inside a `relative`
 * wrapper (ZoomFrame is one).
 */
export const AxisBaselineNote = ({ baseline, format = (n) => formatCompact(n, 2), side = "left" }: Props) => {
  if (baseline == null) return null;
  return (
    <p
      className={`pointer-events-none absolute bottom-8 z-10 rounded ${side === "left" ? "left-14" : "right-14"} bg-background/80 px-1 text-xs text-muted-foreground`}
      data-testid="axis-baseline-note"
    >
      {side === "right" ? "Right axis" : "Axis"} starts at {format(baseline)}
    </p>
  );
};
