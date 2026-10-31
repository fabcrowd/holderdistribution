import { cloneElement, useRef, useState, type ReactElement } from "react";
import { ReferenceLine } from "recharts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { markerTooltip, type ChartNote, type MarkerGroup, type MarkerTone } from "@/lib/chartMarkers";

const TONE_COLOR: Record<MarkerTone, string> = {
  warning: "hsl(var(--ha-warning))",
  accent: "hsl(var(--ha-accent))",
  muted: "hsl(var(--muted-foreground))",
};

type DotProps = { viewBox?: { x?: number; y?: number; height?: number }; color: string; tip: string };

/** Half-width of the invisible hover strip along the dashed line. */
const LINE_HIT_HALF_WIDTH = 6;

/**
 * Small dot at the top of a reference line; recharts passes the line's viewBox.
 * Hover (dot or line) or tap/click opens a one-line explanation. The hit target
 * is 24px, growing to 44px below xl. It is deliberately not a Tab stop: each
 * chart keeps exactly one (the plot, see ZoomFrame), and arrowing the plot onto
 * this marker's row already lists the same wording under the data tooltip.
 */
const MarkerDot = ({ viewBox, color, tip }: DotProps) => {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const x = viewBox?.x ?? 0;
  const y = viewBox?.y ?? 0;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) pinned.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <g
          role="img"
          aria-label={tip}
          data-testid="chart-marker-hit"
          className="cursor-help"
          onClick={(e) => {
            e.stopPropagation();
            pinned.current = !(open && pinned.current);
            setOpen(pinned.current);
          }}
          onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(true)}
          onPointerLeave={(e) => e.pointerType === "mouse" && !pinned.current && setOpen(false)}
        >
          {viewBox?.height ? (
            <rect
              x={x - LINE_HIT_HALF_WIDTH}
              y={y}
              width={LINE_HIT_HALF_WIDTH * 2}
              height={viewBox.height}
              fill="transparent"
            />
          ) : null}
          <circle cx={x} cy={y + 4} className="[r:12px] max-xl:[r:22px]" fill="transparent" />
          <circle cx={x} cy={y + 4} r={3} fill={color} stroke="hsl(var(--background))" strokeWidth={1} data-testid="chart-marker" />
        </g>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-auto max-w-sm p-2 text-xs"
      >
        {tip}
      </PopoverContent>
    </Popover>
  );
};

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
        label={<MarkerDot color={color} tip={markerTooltip(g)} />}
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
