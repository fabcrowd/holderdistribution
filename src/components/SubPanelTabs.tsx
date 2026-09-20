import { type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type SubPanel = { id: string; label: string };

type SubPanelTabsProps = {
  panels: SubPanel[];
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  /** Extra classes for the row holding the selector — e.g. page gutters. */
  className?: string;
  /** Rendered at the right end of the selector row, on the same line. Used in
   *  focus mode to fold the chain filter into this row: two full-width control
   *  rows stacked cost ~135px of desktop viewport above the chart, and the
   *  selector row is mostly empty space past the last label anyway. */
  trailing?: ReactNode;
};

/**
 * Second-level navigation inside a widget that would otherwise be one long
 * stack.
 *
 * Deliberately an UNDERLINE bar, not a pill group. The first version of this
 * used the filled segmented-control treatment from TierFlowDiagram, and on
 * screen the result was backwards: the page-level tab (a pale tinted pill) sat
 * above a solid-primary sub-panel pill, so the subordinate control read as the
 * louder of the two. Pills also put a third pill row on the Distribution tab,
 * which already has two inside TierFlowDiagram. An underline is a different
 * KIND of control from a pill, so it cannot compete on weight no matter what
 * accent the tab above it uses, and it reads as "sections within this card".
 *
 * The row scrolls horizontally rather than wrapping: a wrapped selector costs
 * a second row of chrome above the data on a phone, which is exactly the
 * mistake the page-level `grid-cols-2` TabsList made (~94px). `w-max min-w-full`
 * keeps the baseline rule spanning the card even when the labels don't fill it.
 *
 * Inactive TabsContent unmounts, so the charts in hidden panels are not in the
 * DOM at all — that is the point, not just the reduced scroll height.
 */
export const SubPanelTabs = ({ panels, value, onValueChange, children, className = "", trailing }: SubPanelTabsProps) => (
  <Tabs value={value} onValueChange={onValueChange}>
    <div className={`flex items-end gap-3 ${className}`}>
    <div className="min-w-0 flex-1 overflow-x-auto [-webkit-overflow-scrolling:touch]">
      <TabsList className="inline-flex h-auto w-max min-w-full flex-nowrap justify-start gap-1 rounded-none border-b border-border/60 bg-transparent p-0">
        {panels.map((panel) => (
          <TabsTrigger
            key={panel.id}
            value={panel.id}
            className="min-h-[44px] whitespace-nowrap rounded-none border-b-2 border-transparent bg-transparent px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none sm:text-sm"
          >
            {panel.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
    {trailing ? <div className="shrink-0 pb-1">{trailing}</div> : null}
    </div>
    {children}
  </Tabs>
);
