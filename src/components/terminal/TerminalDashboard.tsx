import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Coins, Info, LayoutGrid, Minus, PanelsTopLeft, PieChart, Users } from "lucide-react";
import logoIcon from "@/assets/holder-analytics-icon.svg";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { GlossaryDialog } from "@/components/GlossaryDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TimeRangeDropdown } from "@/components/TimeRangeDropdown";
import { Footer } from "@/components/Footer";
import { useHeadlineSummary } from "@/hooks/useHeadlineSummary";
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";
import { describeFreshness } from "@/lib/format";
import type { SummaryPoint } from "@/lib/holderSummary";
import type { ViewId } from "@/lib/viewRoute";

const VIEWS: Array<{ id: ViewId; label: string; icon: typeof Users }> = [
  { id: "holders", label: "Holders", icon: Users },
  { id: "distribution", label: "Distribution", icon: PieChart },
  { id: "supply", label: "Supply", icon: Coins },
];

const CHAINS: Array<{ key: DisplaySelection; label: string }> = [
  { key: "combined", label: "All chains" },
  { key: "ethereum", label: "Ethereum" },
  { key: "polygon", label: "Polygon" },
  { key: "base", label: "Base" },
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
 * Desktop (>=1280px) shell: one 48px header row carrying identity, view
 * switch, the four headline KPIs and every control; a viewport-height grid
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
  const { summary, snapshot, tiles } = useHeadlineSummary(rangeDays);
  const fresh = describeFreshness(snapshot?.generatedAt);
  const stale = fresh.status === "delayed" || fresh.status === "stale";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground" data-testid="terminal">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
          <Link to="/" className="flex shrink-0 items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <img src={logoIcon} alt="" width={28} height={28} className="h-7 w-7" />
            <span className="sr-only">Holder Analytics home</span>
          </Link>
          <h1 className="hidden shrink-0 text-sm font-bold tracking-tight 2xl:block">TEL holder distribution</h1>

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
                  className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <v.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {v.label}
                </a>
              );
            })}
          </nav>

          <dl className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden px-1" aria-label="Headline numbers">
            {tiles.map((t) => (
              <div key={t.id} className="flex min-w-0 shrink-0 flex-col leading-tight">
                <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t.label}</dt>
                <dd className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="text-sm font-bold tabular-nums">{t.value}</span>
                  {t.current !== null && (
                    <ChangeIndicator current={t.current} previous={t.previous} formatter={t.fmt} tone={t.tone ?? "auto"} changelogEvents={t.changelogEvents} />
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
                    title={on ? "Every chart and table for this view, one at a time" : "All key charts on one screen"}
                    className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      explore === on ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
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
            <GlossaryDialog className="!min-h-0 h-8 px-2 text-xs" />
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden p-2 focus:outline-none">
          {children}
        </main>

        <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
          <span className={stale ? "font-semibold text-[hsl(var(--ha-warning))]" : undefined} role={stale ? "status" : undefined}>
            {fresh.status === "unknown" ? "Loading data…" : fresh.status === "fresh" ? `Updated ${fresh.relative}` : `Data from ${fresh.date} · daily refresh delayed`}
          </span>
          <span aria-hidden="true">·</span>
          <span>On-chain data for Ethereum, Polygon and Base. Prices by CoinGecko.</span>
          <span className="ml-auto">Independent community project. Not financial advice.</span>
          <Sheet>
            <SheetTrigger asChild>
              <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                About &amp; links
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
              <SheetHeader className="text-left">
                <SheetTitle>About Holder Analytics</SheetTitle>
                <SheetDescription>Official links, support and disclaimer.</SheetDescription>
              </SheetHeader>
              <Footer />
            </SheetContent>
          </Sheet>
        </footer>
      </div>
    </TooltipProvider>
  );
};
