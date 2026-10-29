import { cloneElement, type ReactElement } from "react";
import { ReferenceLine } from "recharts";
import type { ChartNote, MarkerGroup, MarkerTone } from "@/lib/chartMarkers";

const TONE_COLOR: Record<MarkerTone, string> = {
  warning: "hsl(var(--ha-warning))",
  accent: "hsl(var(--ha-accent))",
  muted: "hsl(var(--muted-foreground))",
};

type DotProps = { viewBox?: { x?: number; y?: number }; color: string };

/** Small dot at the top of a reference line; recharts passes the line's viewBox. */
const MarkerDot = ({ viewBox, color }: DotProps) => (
  <circle
    cx={viewBox?.x ?? 0}
    cy={(viewBox?.y ?? 0) + 4}
    r={3}
    fill={color}
    stroke="hsl(var(--background))"
    strokeWidth={1}
    data-testid="chart-marker"
  />
);

/** One dashed rule with a dot per collapsed group. Its wording lives in the tooltip. */
// Returns elements, not a component: recharts matches ReferenceLine children by type.
// eslint-disable-next-line react-refresh/only-export-components
export const markerLines = (groups: readonly MarkerGroup<ChartNote>[], keyPrefix: string, yAxisId?: string) =>
  groups.map((g) => {
    const color = TONE_COLOR[g.items[0].tone];
    return (
      <ReferenceLine
        key={`${keyPrefix}-${g.t}`}
        x={g.t}
        {...(yAxisId ? { yAxisId } : {})}
        stroke={color}
        strokeDasharray="3 3"
        strokeWidth={1}
        label={<MarkerDot color={color} />}
      />
    );
  });

/** Notes for the hovered row, listed under the tooltip card. */
export const MarkerNotes = ({ notes }: { notes: readonly string[] }) => (
  <ul className="mt-1 max-w-[16rem] space-y-0.5 text-xs text-muted-foreground" data-testid="marker-notes">
    {notes.map((n) => (
      <li key={n}>{n}</li>
    ))}
  </ul>
);

type TooltipProps = { active?: boolean; label?: unknown };

/**
 * Tooltip content that also lists the annotation notes for the hovered row.
 * `base` is the normal tooltip element; recharts clones this element with the
 * hover props, and they are forwarded to `base` as well.
 */
export const NotedTooltip = ({
  notes,
  base,
  ...hover
}: TooltipProps & { notes: ReadonlyMap<number, readonly string[]>; base: ReactElement }) => {
  const rowNotes = typeof hover.label === "number" ? notes.get(hover.label) : undefined;
  return (
    <>
      {cloneElement(base, hover)}
      {hover.active && rowNotes && rowNotes.length > 0 && <MarkerNotes notes={rowNotes} />}
    </>
  );
};
