import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Clock, Coins, Info, LayoutGrid, Minus, PanelsTopLeft, PieChart, Users } from "lucide-react";
import logoIcon from "@/assets/holder-analytics-icon.svg";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { GlossaryDialog } from "@/components/GlossaryDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TokenSwitcher } from "@/components/TokenSwitcher";
import { useProject } from "@/hooks/useProject";
import { TimeRangeDropdown } from "@/components/TimeRangeDropdown";
import { Footer } from "@/components/Footer";
import { useHeadlineSummary } from "@/hooks/useHeadlineSummary";
import { useCountUp, useIntro } from "@/hooks/useMotion";
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";
import { describeFreshness } from "@/lib/format";
import type { SummaryPoint } from "@/lib/holderSummary";
import type { ViewId } from "@/lib/viewRoute";

const VIEWS: Array<{ id: ViewId; label: string; icon: typeof Users }> = [
  { id: "holders", label: "Holders", icon: Users },
  { id: "distribution", label: "Distribution", icon: PieChart },
  { id: "supply", label: "Supply", icon: Coins },
];

/** Chain picker options: "All chains" plus the active project's chains. */
const chainOptions = (chains: Array<{ key: string; name: string }>): Array<{ key: DisplaySelection; label: string }> => [
  { key: "combined", label: "All chains" },
  ...chains.map((c) => ({ key: c.key as DisplaySelection, label: c.name })),
];

const TREND: Record<SummaryPoint["trend"], { Icon: typeof Minus; cls: string }> = {
  up: { Icon: ArrowUpRight, cls: "text-positive" },
  down: { Icon: ArrowDownRight, cls: "text-negative" },
  flat: { Icon: Minus, cls: "text-muted-foreground" },
  unknown: { Icon: Minus, cls: "text-muted-foreground" },
};

type Props = {
  view: ViewId;
  onViewChange: (v: ViewId) => void;
  explore: boolean;
  /** Present only for views that have an Explore mode. */
  onExploreChange?: (explore: boolean) => void;
  rangeDays: number;
  onRangeDaysChange: (d: number) => void;
  rangeOptions: Array<{ label: string; days: number }>;
  selectedView: DisplaySelection;
  onSelectedViewChange: (v: DisplaySelection) => void;
  children: ReactNode;
};

/**
 * Desktop (>=1280px) shell: one 56px title bar carrying the brand (eyebrow +
 * an always-visible "<TICKER> Holder Distribution" h1 whose ticker is the
 * master token switch, plus a stale-data pill),
 * the view switch, the four headline KPIs and every control; a viewport-height grid
 * below it; a 24px status line. The document itself never scrolls; panels
 * scroll internally.
 */
export const TerminalDashboard = ({
  view,
  onViewChange,
  explore,
  onExploreChange,
  rangeDays,
  onRangeDaysChange,
  rangeOptions,
  selectedView,
  onSelectedViewChange,
  children,
}: Props) => {
  const { summary, snapshot, tiles, isError } = useHeadlineSummary(rangeDays, selectedView);
  const { project } = useProject();
  const CHAINS = chainOptions(project.chains);
  const qc = useQueryClient();
  const fresh = describeFreshness(snapshot?.generatedAt);
  const stale = fresh.status === "delayed" || fresh.status === "stale";
  const intro = useIntro();
  // The first view fades in with the panel stagger; later view switches get a
  // quick crossfade instead (the keyed wrapper below remounts per view).
  // The first view rides the header's intro fade; every later switch
  // (including back to the first view) gets the short view crossfade.
  const firstView = useRef(view);
  const switched = useRef(false);
  if (view !== firstView.current) switched.current = true;
  const viewIn = switched.current || !intro ? "ha-view-in" : "";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground" data-testid="terminal">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        <header
          className={`relative flex h-14 shrink-0 items-center gap-3 ${intro ? "ha-fade-in" : ""} border-b border-border bg-card px-3 shadow-[0_1px_0_0_hsl(var(--border))] 2xl:gap-5 2xl:px-4`}
          data-testid="terminal-header"
        >
          {/* Brand accent: a 2px primary rule across the top of the bar so the
              header reads as the portal's title bar, not another panel. */}
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary via-primary/70 to-[hsl(var(--ha-accent))]" />
          <div className="flex shrink-0 items-center gap-2.5">
            <Link to="/" className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <img src={logoIcon} alt="" width={36} height={36} className="h-8 w-8 min-[1400px]:h-9 min-[1400px]:w-9" />
              <span className="sr-only">Holder Analytics home</span>
            </Link>
            <div className="flex flex-col justify-center leading-none">
              <div className="flex items-center gap-1.5">
                {/* When the data is late the pill takes the eyebrow's place
                    below 1400px, so the brand column doesn't grow into the KPIs. */}
                <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] text-primary ${stale ? "hidden min-[1400px]:inline" : ""}`}>
                  Holder Analytics
                </span>
                {stale && (
                  <span
                    role="status"
                    data-testid="header-stale-pill"
                    data-status={fresh.status}
                    title={`The daily refresh is behind. Figures are as of ${fresh.date}.`}
                    aria-label={`Data as of ${fresh.date}. The daily refresh is behind.`}
                    className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-semibold leading-none ${
                      fresh.status === "stale"
                        ? "border-red-500/50 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                        : "border-amber-500/50 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                    }`}
                  >
                    <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                    {fresh.status === "stale" ? "Stale · " : ""}As of {fresh.monthDay}
                  </span>
                )}
              </div>
              <h1 className="mt-1 whitespace-nowrap text-base font-extrabold leading-none tracking-tight text-foreground min-[1400px]:text-lg 2xl:text-xl">
                <TokenSwitcher variant="heading" /> Holder Distribution
              </h1>
            </div>
          </div>

          <nav aria-label="Views" className="flex shrink-0 items-center rounded-md border border-border bg-muted/50 p-0.5">
            {VIEWS.map((v) => {
              const active = v.id === view;
              return (
                <a
                  key={v.id}
                  href={`#${v.id}`}
                  aria-current={active ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    onViewChange(v.id);
                  }}
                  className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <v.icon className="hidden h-3.5 w-3.5 2xl:block" aria-hidden="true" />
                  {v.label}
                </a>
              );
            })}
          </nav>

          <dl className="flex min-w-0 flex-1 items-center justify-[safe_center] gap-3 min-[1400px]:gap-6 2xl:gap-10" aria-label="Headline numbers" data-testid="headline-numbers">
            {tiles.map((t) => (
              <div key={t.id} className="flex shrink-0 flex-col gap-0.5 leading-tight" data-testid={`kpi-${t.id}`}>
                <dt className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t.label}
                  {/* A chain is picked but this figure can't be split by
                      chain: say so rather than pass it off as that chain's. */}
                  {selectedView !== "combined" && t.scope === "all" && (
                    <span className="ml-1 rounded-sm bg-muted px-1 text-[9px] normal-case tracking-normal" title="Not split by chain: this figure covers all chains" data-testid={`kpi-${t.id}-scope`}>
                      All chains
                    </span>
                  )}
                </dt>
                <dd className="flex items-center gap-1.5 whitespace-nowrap">
                  <KpiValue value={t.value} current={t.current} fmt={t.fmt} />
                  {t.current !== null && (
                    // Numeric deltas (e.g. "+195.18M") need room the 1280 bar
                    // doesn't have, so they appear from 1400px; the † reclass
                    // markers are narrow and always show.
                    <span className={t.changelogEvents?.length ? "inline-flex" : "hidden min-[1400px]:inline-flex"}>
                    <ChangeIndicator
                      variant="plain"
                      current={t.current}
                      previous={t.previous}
                      formatter={t.fmt}
                      tone={t.tone ?? "auto"}
                      changelogEvents={t.changelogEvents}
                    />
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {onExploreChange && (
              <div role="group" aria-label="Layout" className="flex items-center rounded-md border border-border p-0.5">
                {[
                  { on: false, label: "Dashboard", Icon: LayoutGrid },
                  { on: true, label: "Explore", Icon: PanelsTopLeft },
                ].map(({ on, label, Icon }) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={explore === on}
                    onClick={() => onExploreChange(on)}
                    title={on ? "Explore: every chart and table for this view, one at a time" : "Dashboard: all key charts on one screen"}
                    aria-label={label}
                    className={`inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded px-1.5 text-xs 2xl:px-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      explore === on ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="hidden 2xl:inline">{label}</span>
                  </button>
                ))}
              </div>
            )}
            <label className="sr-only" htmlFor="terminal-chain">
              Chain
            </label>
            <select
              id="terminal-chain"
              value={selectedView}
              onChange={(e) => onSelectedViewChange(e.target.value as DisplaySelection)}
              className="h-8 rounded-full border border-border bg-card px-2.5 text-xs font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CHAINS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <TimeRangeDropdown value={rangeDays} onChange={onRangeDaysChange} options={rangeOptions} />
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Summary of what changed"
                  title="Summary"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="h-4 w-4" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96 space-y-2 text-sm">
                {summary ? (
                  <>
                    <p className="leading-snug">{summary.headline}</p>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {summary.points.map((p) => {
                        const { Icon, cls } = TREND[p.trend];
                        return (
                          <li key={p.id} className="flex items-start gap-1.5">
                            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cls}`} aria-hidden="true" />
                            {p.text}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  <p className="text-muted-foreground">Summary unavailable.</p>
                )}
              </PopoverContent>
            </Popover>
            <GlossaryDialog className="!min-h-0 h-8 px-2 text-xs" labelClassName="sr-only 2xl:not-sr-only" />
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden p-2 focus:outline-none">
          <div key={view} className={`h-full min-h-0 ${viewIn}`}>
            {children}
          </div>
        </main>

        <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
          {fresh.status === "unknown" && isError ? (
            <span role="alert" className="inline-flex items-center gap-2 font-semibold text-destructive">
              Couldn&apos;t load the holder snapshot.
              <button
                type="button"
                onClick={() => void qc.refetchQueries({ predicate: (q) => q.state.status === "error" })}
                className="rounded border border-border px-1.5 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            </span>
          ) : (
            <span className={fresh.status === "stale" ? "font-semibold text-destructive" : stale ? "font-semibold text-[hsl(var(--ha-warning))]" : undefined}>
              {fresh.status === "unknown" ? "Loading data…" : fresh.status === "fresh" ? `Updated ${fresh.relative}` : fresh.status === "stale" ? `Stale: data from ${fresh.date} (${fresh.ageDays} days old)` : `Data from ${fresh.date} · daily refresh delayed`}
            </span>
          )}
          <span aria-hidden="true">·</span>
          <span>On-chain data for Ethereum, Polygon and Base. Prices by CoinGecko.</span>
          <span className="ml-auto">Independent community project. Not financial advice.</span>
          <Sheet>
            <SheetTrigger asChild>
              <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                About &amp; support
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
              <SheetHeader className="text-left">
                <SheetTitle>About Holder Analytics</SheetTitle>
                <SheetDescription>Support the project, and the disclaimer.</SheetDescription>
              </SheetHeader>
              <Footer />
            </SheetContent>
          </Sheet>
        </footer>
      </div>
    </TooltipProvider>
  );
};


/**
 * Headline value. Values fade in with the header rather than counting up (a
 * count-up read as the numbers "changing" on every visit); `useCountUp` with a
 * zero duration returns the target immediately.
 */
const KpiValue = ({ value, current }: { value: string; current: number | null; fmt?: (v: number) => string }) => {
  useCountUp(current, 0);
  return <span className="relative text-base font-semibold tabular-nums text-foreground min-[1400px]:text-lg">{value}</span>;
};
