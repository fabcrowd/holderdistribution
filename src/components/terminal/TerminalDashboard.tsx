import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Clock, Coins, Info, Minus, PieChart, Users } from "lucide-react";
import logoIcon from "@/assets/holder-analytics-icon.svg";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GlossaryDialog } from "@/components/GlossaryDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TokenIdentity } from "@/components/TokenIdentity";
import { useProject } from "@/hooks/useProject";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { AnswerCards } from "./AnswerCards";
import { TimeRangeDropdown } from "@/components/TimeRangeDropdown";
import { DisclaimerLink, Footer } from "@/components/Footer";
import { useHeadlineSummary } from "@/hooks/useHeadlineSummary";
import { useIntro } from "@/hooks/useMotion";
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";
import { chainViewOptions } from "@/lib/chainViews";
import { describeFreshness } from "@/lib/format";
import type { SummaryPoint } from "@/lib/holderSummary";
import type { ViewId } from "@/lib/viewRoute";

const VIEWS: Array<{ id: ViewId; label: string; icon: typeof Users }> = [
  { id: "holders", label: "Holders", icon: Users },
  { id: "distribution", label: "Distribution", icon: PieChart },
  { id: "supply", label: "Supply", icon: Coins },
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
  rangeDays: number;
  onRangeDaysChange: (d: number) => void;
  rangeOptions: Array<{ label: string; days: number }>;
  selectedView: DisplaySelection;
  onSelectedViewChange: (v: DisplaySelection) => void;
  children: ReactNode;
};

/**
 * Desktop (>=1280px) shell: one 64px title bar carrying the brand (site mark +
 * "Holder Distribution" h1, plus a stale pill only when the refresh is behind),
 * the view switch, and every control, with the open token's mark beside the
 * chain and timeframe pickers; then three answer cards (holders, held, on
 * exchanges); then the view.
 * Holders dashboard and Distribution scroll this region so charts can be
 * taller than the fold. Supply and Explore still fill the viewport and
 * scroll inside their panels. A 24px status line stays pinned, with the
 * shared legal disclaimer directly under it.
 */
export const TerminalDashboard = ({
  view,
  onViewChange,
  explore,
  rangeDays,
  onRangeDaysChange,
  rangeOptions,
  selectedView,
  onSelectedViewChange,
  children,
}: Props) => {
  const { summary, snapshot, tiles, isError } = useHeadlineSummary(rangeDays, selectedView);
  const { project } = useProject();
  const { t } = useProjectCopy();
  // Holders dashboard and Distribution grow past the fold. Supply and the
  // one-chart Explore view keep a viewport-locked panel.
  const mainScrolls = (view === "holders" && !explore) || view === "distribution";
  // Chain picker: "All chains" plus the active project's chains[] (src/lib/chainViews.ts).
  const CHAINS = chainViewOptions(project, "All chains");
  const qc = useQueryClient();
  const fresh = describeFreshness(snapshot?.generatedAt);
  const stale = fresh.status === "delayed" || fresh.status === "stale";
  // The status bar carries the only freshness notice besides the header pill:
  // loading and error states, and the amber/red stale notice.
  const showStatusNotice = fresh.status === "unknown" || stale;
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
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
        >
          Skip to main content
        </a>
        <header
          className={`relative flex h-16 shrink-0 items-center gap-3 ${intro ? "ha-fade-in" : ""} border-b border-border bg-card px-3 shadow-[0_1px_0_0_hsl(var(--border))] 2xl:gap-5 2xl:px-4`}
          data-testid="terminal-header"
        >
          {/* Brand accent: a 2px primary rule across the top of the bar so the
              header reads as the portal's title bar, not another panel. */}
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary via-primary/70 to-[hsl(var(--ha-accent))]" />
          <div className="flex shrink-0 items-center gap-2">
            <h1 className="whitespace-nowrap text-base font-extrabold tracking-tight text-foreground min-[1400px]:text-lg 2xl:text-xl">
              <Link to="/" aria-label="Holder Distribution home" className="flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <img src={logoIcon} alt="" width={32} height={32} className="h-8 w-8" />
                Holder Distribution
              </Link>
            </h1>
            {/* Shown only when the daily refresh is behind; a fresh snapshot needs no
                badge, and the date is not worth the header's width. */}
            {stale && (
              <span
                role="status"
                data-testid="header-stale-pill"
                data-status={fresh.status}
                title="The daily refresh is behind."
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-xs font-semibold leading-none ${
                  fresh.status === "stale"
                    ? "border-red-500/50 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                    : "border-amber-500/50 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                }`}
              >
                <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                {fresh.status === "stale" ? "Stale" : "Delayed"}
              </span>
            )}
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
                  className={`inline-flex h-9 items-center gap-1.5 rounded px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <v.icon className="hidden h-3.5 w-3.5 2xl:block" aria-hidden="true" />
                  {v.label}
                </a>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <TokenIdentity iconOnly className="mr-1" />
            <label className="sr-only" htmlFor="terminal-chain">
              Chain
            </label>
            <select
              id="terminal-chain"
              value={selectedView}
              onChange={(e) => onSelectedViewChange(e.target.value as DisplaySelection)}
              className="h-9 rounded-full border border-border bg-card px-3 text-[13px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CHAINS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <TimeRangeDropdown value={rangeDays} onChange={onRangeDaysChange} options={rangeOptions} className="xl:!h-9 xl:!text-[13px]" />
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Summary of what changed"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Info className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Summary of what changed</TooltipContent>
              </Tooltip>
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
            <GlossaryDialog className="!min-h-0 h-9 px-2.5 text-[13px]" labelClassName="sr-only xl:not-sr-only" />
            <ThemeToggle className="!h-9 !w-9" />
          </div>
        </header>

        {!explore && (
          <div data-testid="terminal-headline" className="shrink-0 border-b border-border bg-background px-3 py-3">
            <AnswerCards tiles={tiles} selectedView={selectedView} isError={isError} />
          </div>
        )}

        <main
          id="main-content"
          tabIndex={-1}
          className={`relative min-h-0 flex-1 p-3 focus:outline-none ${mainScrolls ? "overflow-y-auto" : "overflow-hidden"}`}
        >
          <div key={view} className={mainScrolls ? `min-h-full ${viewIn}` : `h-full min-h-0 ${viewIn}`}>
            {children}
          </div>
        </main>

        <footer className="shrink-0 border-t border-border bg-card text-xs text-muted-foreground">
          <div className="flex h-6 items-center gap-3 px-3">
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
            ) : fresh.status === "unknown" ? (
              <span>Loading data…</span>
            ) : stale ? (
              <span className={fresh.status === "stale" ? "font-semibold text-destructive" : "font-semibold text-[hsl(var(--ha-warning))]"}>
                {fresh.status === "stale" ? `Stale: data from ${fresh.date} (${fresh.ageDays} days old)` : `Data from ${fresh.date} · daily refresh delayed`}
              </span>
            ) : null}
            {showStatusNotice && <span aria-hidden="true">·</span>}
            <span>On-chain data for {t("{chains}")}. Prices by CoinGecko.</span>
            <span aria-hidden="true">·</span>
            <span>Not financial advice.</span>
            <DisclaimerLink />
            <Sheet>
              <SheetTrigger asChild>
                <button type="button" className="ml-auto font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  About &amp; support
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
                <SheetHeader className="text-left">
                  <SheetTitle>About Holder Distribution</SheetTitle>
                  <SheetDescription>Support the project, and the disclaimer.</SheetDescription>
                </SheetHeader>
                <Footer />
              </SheetContent>
            </Sheet>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
};
