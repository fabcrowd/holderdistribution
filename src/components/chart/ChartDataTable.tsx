import { cn } from "@/lib/utils";
import { DEFAULT_TABLE_MAX_ROWS, formatCell, limitTableRows, tableNote, tableTitleFor } from "@/lib/chartTable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type ChartTableColumn = {
  key: string;
  label: string;
  format?: (v: unknown) => string;
  align?: "left" | "right";
};

type Props = {
  /** Names the table for screen readers and labels its region. */
  caption: string;
  /** Short dialog title; defaults to the caption. */
  title?: string;
  columns: ChartTableColumn[];
  rows: Record<string, unknown>[];
  maxRows?: number;
  className?: string;
  /** Rows arrive oldest first and are shown reversed (default). False keeps their order. */
  newestFirst?: boolean;
  /** Sheet description; defaults to the values-behind-the-chart line. */
  description?: string;
};

/** The scroll region, table and note: what the sheet shows. Rows are newest first. */
export const ChartDataTableBody = ({ caption, columns, rows, maxRows = DEFAULT_TABLE_MAX_ROWS, newestFirst = true }: Omit<Props, "className" | "description">) => {
  const limited = limitTableRows(rows, maxRows);
  const note = tableNote(limited.rows.length, limited.total);
  const ordered = newestFirst ? [...limited.rows].reverse() : limited.rows;
  return (
    <>
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className="max-h-[60vh] overflow-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full text-xs tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr>
              {columns.map((col) => (
                <th key={col.key} scope="col" className={cn("px-2 py-1 font-medium", col.align === "right" ? "text-right" : "text-left")}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, i) => (
              <tr key={i} className="border-t border-border/50">
                {columns.map((col) => (
                  <td key={col.key} className={cn("px-2 py-1", col.align === "right" ? "text-right" : "text-left")}>
                    {formatCell(row[col.key], col.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </>
  );
};

/**
 * Text alternative for a chart: a "View data as table" button that opens the
 * numbers behind the plot in a right-hand sheet, so the panel's chart keeps its
 * full height. Rows are newest first. Nothing renders without rows.
 */
export const ChartDataTable = ({ caption, title, className, description, ...rest }: Props) => {
  if (rest.rows.length === 0) return null;
  return (
    <div className={cn("text-xs", className)}>
      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-xl:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View data as table
          </button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
          // The sheet is portaled but still bubbles through the React tree to the chart's zoom frame.
          // Keys: only Escape (closing this sheet) should reach it. Pointer and wheel: never zoom or pan the chart.
          onKeyDown={(e) => {
            if (e.key !== "Escape") e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <SheetHeader className="text-left">
            <SheetTitle>{tableTitleFor(caption, title)}</SheetTitle>
            <SheetDescription>{description ?? "The values behind the chart, newest first."}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <ChartDataTableBody caption={caption} {...rest} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};
