import { CheckCircle2, Clock } from "lucide-react";
import { describeFreshness, type Freshness } from "@/lib/format";
import { Callout } from "@/components/ui/callout";

const TONE: Record<Freshness["status"], string> = {
  fresh: "border-border bg-muted text-muted-foreground",
  delayed: "border-warning/40 bg-warning-tint text-warning",
  stale: "border-warning/40 bg-warning-tint text-warning",
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
    <Callout role="status" data-testid="stale-banner">
      <p>
        <span className="font-semibold">Showing data from {f.date}</span>
        <span className="text-foreground/80">
          {" "}
          ({f.relative}). The daily refresh is behind, so figures are accurate as of that date, not today.
        </span>
      </p>
    </Callout>
  );
};
