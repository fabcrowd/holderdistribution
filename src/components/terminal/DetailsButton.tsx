import { Maximize2 } from "lucide-react";

/** Opens the full, multi-view panel behind a dashboard cell. */
export const DetailsButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={`Open ${label} details`}
    title="Open details"
    className="inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <Maximize2 className="h-3 w-3" aria-hidden="true" />
    <span className="hidden 2xl:inline">Details</span>
  </button>
);
