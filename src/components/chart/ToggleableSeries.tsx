import type { ReactNode } from "react";
import { useSeriesToggle } from "@/hooks/useSeriesToggle";
import { ChartLegend, type LegendItem } from "./ChartLegend";

type Props = {
  items: readonly LegendItem[];
  className?: string;
  /** Render the chart; draw only the series for which `isVisible(key)` is true. */
  children: (isVisible: (key: string) => boolean) => ReactNode;
};

/**
 * Legend + toggle state for charts rendered where a hook cannot be called
 * (render helpers, loops). Behaves like `useSeriesToggle` + `ChartLegend`.
 */
export function ToggleableSeries({ items, className, children }: Props) {
  const toggled = useSeriesToggle(items.map((i) => i.key));
  return (
    <>
      <ChartLegend items={items} hidden={toggled.hidden} onToggle={toggled.toggle} className={className} />
      {children(toggled.isVisible)}
    </>
  );
}
