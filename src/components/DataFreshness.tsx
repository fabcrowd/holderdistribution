import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { describeFreshness, type Freshness } from "@/lib/format";

const TONE: Record<Freshness["status"], string> = {
  fresh: "border-border bg-muted text-muted-foreground",
  delayed: "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  stale: "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  unknown: "border-border/60 bg-muted/40 text-muted-foreground",
};

/** Compact "Updated 5 hours ago" / "Data from Oct 2" pill. */
export const DataFreshnessBadge = ({ generatedAt, now }: { generatedAt: string | null | undefined; now?: number }) => {
  const f = describeFreshness(generatedAt, now);
  if (f.status === "unknown") return null;
  const Icon = f.status === "fresh" ? CheckCircle2 : Clock;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[f.status]}`}
      title={f.date ? `Snapshot taken ${f.date}` : undefined}
      data-testid="freshness-badge"
      data-status={f.status}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {f.status === "fresh" ? `Updated ${f.relative}` : `Data from ${f.date}`}
    </span>
  );
};

/**
 * Page-level, plain-language notice when the daily refresh has fallen behind.
 * Amber and calm rather than a red error: the numbers are still correct as of
 * their date, the reader just needs to know which date that is.
 */
export const StaleDataBanner = ({ generatedAt, now }: { generatedAt: string | null | undefined; now?: number }) => {
  const f = describeFreshness(generatedAt, now);
  if (f.status !== "delayed" && f.status !== "stale") return null;
  return (
    <div
      role="status"
      data-testid="stale-banner"
      className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-50/90 px-3.5 py-2.5 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="leading-snug">
        <span className="font-semibold">Showing data from {f.date}</span>
        <span className="text-amber-900/90 dark:text-amber-200/90">
          {" "}
          ({f.relative}). The daily refresh is behind, so figures are accurate as of that date, not today.
        </span>
      </p>
    </div>
  );
};
