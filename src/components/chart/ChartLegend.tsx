import { cn } from "@/lib/utils";

export type LegendItem = { key: string; label: string; color: string; dashed?: boolean; note?: string };

type Props = {
  items: readonly LegendItem[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  className?: string;
  "data-testid"?: string;
};

/**
 * Click-to-toggle legend. The last visible series cannot be hidden
 * (`toggleHidden` refuses), so its button reports `aria-disabled`.
 */
export function ChartLegend({ items, hidden, onToggle, className, ...rest }: Props) {
  const visibleCount = items.filter((i) => !hidden.has(i.key)).length;
  return (
    <ul className={cn("m-0 flex shrink-0 list-none flex-wrap items-center gap-x-3 gap-y-1 max-xl:gap-y-0.5 p-0 text-xs text-muted-foreground", className)} {...rest}>
      {items.map((item) => {
        const off = hidden.has(item.key);
        const last = !off && visibleCount === 1;
        return (
          <li key={item.key}>
            <button
              type="button"
              aria-pressed={!off}
              aria-disabled={last || undefined}
              title={last ? "At least one series stays visible" : off ? `Show ${item.label}` : `Hide ${item.label}`}
              onClick={() => onToggle(item.key)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1 py-0.5 max-xl:min-h-11 max-xl:px-2 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                off && "opacity-50 line-through",
                last && "cursor-default",
              )}
            >
              <span
                className="h-0.5 w-3"
                style={{
                  background: item.dashed ? "transparent" : off ? "transparent" : item.color,
                  borderTop: item.dashed ? `2px dashed ${item.color}` : off ? `2px solid ${item.color}` : undefined,
                }}
                aria-hidden="true"
              />
              {item.label}
              {item.note && <span className="opacity-80">({item.note})</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
