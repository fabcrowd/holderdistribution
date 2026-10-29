import { Clock } from "lucide-react";
import { describeFreshness } from "@/lib/format";

/**
 * "Flows as of Sep 20" for a feed that refreshes on its own schedule.
 * Within the 36h daily window it is quiet muted text; once older it becomes a
 * grey pill (red-tinged at a week+) so a lagging feed beside fresh numbers is
 * visible at a glance rather than only in a tooltip.
 */
export const AsOfBadge = ({
  iso,
  label = "As of",
  className = "",
  testId,
}: {
  iso: string | null | undefined;
  label?: string;
  className?: string;
  testId?: string;
}) => {
  const f = describeFreshness(iso);
  if (f.status === "unknown" || !f.monthDay) return null;
  const late = f.status !== "fresh";
  const title = late
    ? `${label} ${f.date} (${f.relative}). This feed refreshes separately and is behind the daily update.`
    : `${label} ${f.date}`;
  return (
    <span
      title={title}
      data-testid={testId}
      data-status={f.status}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs leading-none ${
        late
          ? `rounded-full border px-1.5 py-0.5 font-semibold ${
              f.status === "stale"
                ? "border-red-500/40 bg-muted text-red-800 dark:text-red-300"
                : "border-border bg-muted text-muted-foreground"
            }`
          : "text-muted-foreground"
      } ${className}`}
    >
      {late && <Clock className="h-3 w-3" aria-hidden="true" />}
      <span className="sr-only">{title}</span>
      <span aria-hidden="true">
        {label} {f.monthDay}
      </span>
    </span>
  );
};
