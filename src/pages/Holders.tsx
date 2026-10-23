import { useState, useEffect, useRef, useReducer } from "react";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { usePageMeta } from "@/hooks/usePageMeta";
import WalletHoldingsWidget from "@/components/WalletHoldingsWidget";
import HolderGrowthWidget from "@/components/HolderGrowthWidget";
import { ExchangeFlowWidget } from "@/components/ExchangeFlowWidget";
import DistributionAnalysisWidget from "@/components/DistributionAnalysisWidget";
import { HolderKpiHero } from "@/components/HolderKpiHero";
import type { EcosystemHeadlineTileId } from "@/hooks/useEcosystemHeadlineTiles";
import SupplyBreakdown from "@/components/SupplyBreakdown";
import { TimeRangeDropdown } from "@/components/TimeRangeDropdown";
import { PageIntro } from "@/components/PageIntro";
import { Coins, PieChart, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TerminalDashboard } from "@/components/terminal/TerminalDashboard";
import { HoldersTerminal } from "@/components/terminal/HoldersTerminal";
import { DistributionTerminal } from "@/components/terminal/DistributionTerminal";
import { TERMINAL_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { buildViewHash, DEFAULT_PANEL, parseViewHash, type ViewId } from "@/lib/viewRoute";

import { useHolderLiteSnapshot, type DisplaySelection } from "@/hooks/useHolderSnapshot";
import { RANGE_OPTIONS, ytdDays } from "@/lib/timeRange";
import { useHoldersHistoryData } from "@/hooks/useHoldersHistoryData";
import { pickBaseline } from "@/lib/baseline";
import { useScrolledPastElement } from "@/hooks/useScrolledPastElement";
import {
  HERO_COLLAPSE_INITIAL,
  isHeroCollapsed,
  reduceHeroCollapse,
} from "@/lib/heroCollapse";

const TILE_DESTINATIONS = {
  holders: { tab: "holders", panel: "trends" },
  retailHeld: { tab: "holders", panel: "balances" },
  staked: { tab: "holders", panel: "staking" },
  cex: { tab: "holders", panel: "flows" },
} as const satisfies Record<EcosystemHeadlineTileId, { tab: string; panel: string }>;

const TABS = [
  {
    id: "holders",
    label: "Holders",
    icon: Users,
    blurb: "How many wallets hold TEL, how much they hold and how that is changing.",
    accent: "data-[state=active]:text-primary",
  },
  {
    id: "distribution",
    label: "Distribution",
    icon: PieChart,
    blurb: "Which balance tiers are gaining or losing wallets, and where their TEL went.",
    accent: "data-[state=active]:text-violet-700 dark:data-[state=active]:text-violet-400",
  },
  {
    id: "supply",
    label: "Supply",
    icon: Coins,
    blurb: "Where all 100B TEL sits: retail, exchanges, DEX pools, escrow and Telcoin wallets.",
    accent: "data-[state=active]:text-sky-700 dark:data-[state=active]:text-sky-400",
  },
] as const;
type TabId = ViewId;
const isTabId = (v: string): v is TabId => TABS.some((t) => t.id === v);

const initialRoute = () =>
  (typeof window !== "undefined" ? parseViewHash(window.location.hash) : null) ?? { view: "holders" as ViewId, panel: null };

/** One plain sentence under the hero saying what the open tab answers. */
const TabBlurb = ({ id, hidden }: { id: TabId; hidden: boolean }) => {
  if (hidden) return null;
  const tab = TABS.find((t) => t.id === id)!;
  return (
    <p className="mb-3 text-sm text-muted-foreground">
      <span className="font-semibold text-foreground">{tab.label}:</span> {tab.blurb}
    </p>
  );
};

const Holders = () => {
  // Route stays /holders deliberately — renaming the URL would reset the
  // page's search history and break the homepage tile's stored route for no
  // functional gain. Only the labels describe the page as a whole.
  usePageMeta({
    title: 'TEL Holder Distribution & Tokenomics | Holder Analytics',
    description: 'TEL tokenomics: circulating supply breakdown, holder distribution and tiers, exchange flows, and historical growth from real-time on-chain data.',
    canonicalPath: '/',
  });

  // One panel at a time rather than five stacked accordions. Every section
  // used to start collapsed, so a first-time visitor got the hero and five
  // closed doors — every comparable token page (CoinGecko, Etherscan,
  // DeFiLlama) shows content on load instead. The three widgets that are the
  // sole content of a tab have since dropped their collapsible headers
  // entirely — a collapse control inside a tab that already selects it is
  // duplicated navigation — and use SubPanelTabs internally instead.
  //
  // There is no Overview tab. It had already been reduced to "the Ecosystem
  // Headline and nothing else", and that headline renders above the selector
  // on every tab — so the tab selected an empty panel whose content was
  // already on screen, and landing there meant a second click to reach any
  // data at all. The headline tiles now route into these tabs directly, which
  // is the job Overview was nominally doing. Holders is the default.
  // Each headline tile is a link to the charts behind that number. Before
  // this, reading the growth chart for "Retail Holders" meant clicking the
  // Holders tab and then the Trends sub-tab — two levels of menu between the
  // number and its own history, on a page whose whole first screen is those
  // four numbers. The tile is the more direct control, and it was already the
  // thing being looked at.


  // Deep links keep working: #holders / #distribution / ... select the tab, and
  // switching tabs rewrites the hash so a URL can be copied and shared.
  // "#overview" is still honoured — it was a real tab until 2026-09-13 and is
  // in shared links — but it now resolves to Holders like any other entry
  // point rather than 404ing into the default.
  // Hash routing lives in lib/viewRoute: "#view" or "#view/panel". Hashes
  // that are not views (the skip link's "#main-content") are ignored rather
  // than bouncing the reader back to the default tab.
  const [route0] = useState(initialRoute);
  const [activeTab, setActiveTab] = useState<TabId>(route0.view);
  // Desktop only: a panel in the URL means "Explore" (the full multi-panel
  // widget) instead of the dashboard grid.
  const [explore, setExplore] = useState<boolean>(route0.view === "holders" && route0.panel !== null);
  const [supplyPanel, setSupplyPanel] = useState<string>(
    route0.view === "supply" && route0.panel ? route0.panel : (DEFAULT_PANEL.supply as string),
  );
  const writeHash = (view: ViewId, panel: string | null) => {
    const next = buildViewHash({ view, panel });
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  };
  useEffect(() => {
    const onHash = () => {
      const r = parseViewHash(window.location.hash);
      if (!r) return;
      setActiveTab(r.view);
      if (r.view === "holders") {
        setExplore(r.panel !== null);
        if (r.panel) setHolderPanel(r.panel);
      }
      if (r.view === "supply") setSupplyPanel(r.panel ?? (DEFAULT_PANEL.supply as string));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selectTab = (value: string) => {
    if (!isTabId(value)) return;
    setActiveTab(value);
    setExplore(false);
    writeHash(value, null);
  };
  const isTerminal = useMediaQuery(TERMINAL_QUERY);

  const [selectedView, setSelectedView] = useState<DisplaySelection>("combined");

  // Ecosystem Headline: the tiles themselves are the sticky, morphing
  // element. A sentinel at the hero's natural top edge (heroRef) reports
  // once it scrolls behind the sticky selector bar (stickyBarRef) — at that
  // point the hero pins under the bar and its tiles collapse in place. See
  // HolderKpiHero's `collapsed` prop for the per-tile morph.
  //
  // Collapse is latched for the rest of the visit: scrolling back to the
  // top does not replay the expand animation. Click the collapsed strip
  // (or its chevron) to reopen it. Scrolling past again re-collapses.
  const stickyBarRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const { scrolledPast, stickyOffset } = useScrolledPastElement(heroRef, stickyBarRef);
  const [heroCollapse, dispatchHeroCollapse] = useReducer(
    reduceHeroCollapse,
    HERO_COLLAPSE_INITIAL,
  );
  useEffect(() => {
    dispatchHeroCollapse(scrolledPast ? "scroll-past" : "scroll-back");
  }, [scrolledPast]);
  const heroCollapsed = isHeroCollapsed(heroCollapse);
  // Lands on Trends, not the Holders card's own "Overview" sub-panel. With the
  // Overview TAB gone, Holders is what a fresh visit renders — and that
  // sub-panel opens with the same four metrics the Ecosystem Headline is
  // already showing a few hundred pixels above it, so the first screen said
  // everything twice and the first actual chart sat below both. Trends is the
  // same destination the Retail Holders tile routes to, so landing there and
  // clicking that tile agree with each other. Every panel is still one click
  // away on the row above.
  const [holderPanel, setHolderPanel] = useState<string>(
    route0.view === "holders" && route0.panel ? route0.panel : (DEFAULT_PANEL.holders as string),
  );
  const changeHolderPanel = (panel: string) => {
    setHolderPanel(panel);
    writeHash("holders", panel);
  };
  const changeSupplyPanel = (panel: string) => {
    setSupplyPanel(panel);
    writeHash("supply", panel === DEFAULT_PANEL.supply ? null : panel);
  };
  const openExplore = (panel: string) => {
    setActiveTab("holders");
    setHolderPanel(panel);
    setExplore(true);
    writeHash("holders", panel);
  };
  const changeExplore = (on: boolean) => {
    setExplore(on);
    writeHash("holders", on ? holderPanel : null);
  };
  const [activeTileId, setActiveTileId] = useState<EcosystemHeadlineTileId | null>(null);

  // Collapse first, then route. "select" puts the hero in exactly the state a
  // scroll-past would have, so the charts open in the space the tiles just
  // gave up rather than below a full-height hero the reader would have to
  // scroll past to see what they clicked.
  const handleTileSelect = (id: EcosystemHeadlineTileId) => {
    const destination = TILE_DESTINATIONS[id];
    dispatchHeroCollapse("select");
    setActiveTileId(id);
    setActiveTab(destination.tab);
    changeHolderPanel(destination.panel);
  };

  // A tile stays lit only while its own destination is on screen; changing tab
  // or sub-tab by any other control clears it, so the marker can never claim a
  // view the reader has since navigated away from.
  useEffect(() => {
    if (!activeTileId) return;
    const destination = TILE_DESTINATIONS[activeTileId];
    if (activeTab !== destination.tab || holderPanel !== destination.panel) {
      setActiveTileId(null);
    }
  }, [activeTab, holderPanel, activeTileId]);
  const [rangeDays, setRangeDays] = useState<number>(ytdDays());
  const { data, isError: snapshotError } = useHolderLiteSnapshot();
  const snapshot = data as import('@/hooks/useHolderSnapshot').HolderLiteSnapshot | undefined;

  // Hide range options the archive can't actually answer yet (e.g. "1Y"
  // before the archive is a year old) rather than offering a range whose
  // comparison would immediately show "no baseline available" — reuses the
  // exact same pickBaseline gate every downstream delta/comparison already
  // goes through, so the picker can never promise a range nothing can back.
  // While history is still loading, show the full list rather than
  // flickering options in once the fetch resolves.
  const { data: holdersHistory } = useHoldersHistoryData();
  const visibleRangeOptions = holdersHistory?.entries?.length
    ? RANGE_OPTIONS.filter(
        (option) =>
          option.days <= 1 ||
          pickBaseline(holdersHistory.entries!, option.days, (e) => Date.parse(e.generatedAt ?? e.date)) !== null,
      )
    : RANGE_OPTIONS;

  const holdersWidget = (
    <WalletHoldingsWidget
      // Always, not just in focus mode. The card's title block reads
      // "Holder Snapshot" under a page tab that already says Holders,
      // above a panel that carries its own heading — three names for one
      // thing, and ~150px of them before any data on all eight panels.
      compactHeader
      panel={holderPanel}
      onPanelChange={changeHolderPanel}
      selectedView={selectedView}
      onViewChange={setSelectedView}
      rangeDays={rangeDays}
      onRangeDaysChange={setRangeDays}
      trendsPanel={
        <HolderGrowthWidget selectedView={selectedView} rangeDays={rangeDays} onRangeDaysChange={setRangeDays} />
      }
      flowsPanel={<ExchangeFlowWidget rangeDays={rangeDays} />}
    />
  );

  // Desktop: a no-scroll trading-terminal grid. Rendered instead of (not
  // hidden alongside) the stacked layout, so there is one set of ids and one
  // set of data subscriptions.
  if (isTerminal) {
    return (
      <TerminalDashboard
        view={activeTab}
        onViewChange={selectTab}
        explore={activeTab === "holders" && explore}
        onExploreChange={activeTab === "holders" ? changeExplore : undefined}
        rangeDays={rangeDays}
        onRangeDaysChange={setRangeDays}
        rangeOptions={visibleRangeOptions}
        selectedView={selectedView}
        onSelectedViewChange={setSelectedView}
      >
        {activeTab === "holders" &&
          (explore ? (
            <div className="terminal-dense h-full overflow-auto rounded-lg" data-testid="holders-explore">
              {holdersWidget}
            </div>
          ) : (
            <HoldersTerminal
              snapshot={snapshot}
              snapshotError={snapshotError}
              selectedView={selectedView}
              rangeDays={rangeDays}
              onExplore={openExplore}
            />
          ))}
        {activeTab === "distribution" && (
          <DistributionTerminal
            snapshot={snapshot}
            snapshotError={snapshotError}
            selectedView={selectedView}
            rangeDays={rangeDays}
            onViewChange={setSelectedView}
          />
        )}
        {activeTab === "supply" && (
          <SupplyBreakdown rangeDays={rangeDays} layout="terminal" panel={supplyPanel} onPanelChange={changeSupplyPanel} />
        )}
      </TerminalDashboard>
    );
  }

  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-md"
      >
        Skip to main content
      </a>
      {/* Page identity lives in the main nav, not the selector bar below:
          the mobile nav shows no active state or page name at all, and the
          ~42px a title unit cost in the selector bar was what forced that
          bar to wrap to two rows on a phone. */}
      <Navigation pageTitle="Tokenomics" />
      {/* Tabs spans the sticky selector bar AND the panels below it, so the
          trigger row can live in the fixed header while its content renders
          in <main>. */}
      <Tabs value={activeTab} onValueChange={selectTab}>

      {/* Section + timeframe selectors — locked directly under the main nav so
          they form one continuous fixed header instead of floating further
          down the page. Sticky at the nav's own height (top-16/md:top-20)
          means the two bars sit flush together with no gap, on every
          scroll position, not just once the user scrolls past the hero.
          Shares the nav's background gradient but skips its own shadow so
          the two rows read as one header with a single hairline divider,
          not two stacked cards. */}
      <div
        ref={stickyBarRef}
        className="sticky top-16 md:top-20 z-40 w-full backdrop-blur-xl border-b border-border/40 bg-card/90 shadow-[0_1px_2px_hsl(180_18%_7%/0.05)]"
      >
        {/* Scrolls rather than wraps below sm: a wrapped selector bar costs a
            whole second row of chrome (~40px) on the screen that can least
            afford it — the same mistake the page tab bar's original
            grid-cols-2 made, and the reason SubPanelTabs and the balance
            chart's toggle row both use this pattern. */}
        <div className="mx-auto px-4 py-2 sm:py-2.5 max-w-7xl flex items-center justify-between gap-2 overflow-x-auto [-webkit-overflow-scrolling:touch] sm:flex-wrap sm:overflow-visible">
          {/* Each tab keeps the accent its section header already uses, so a
              reader can map "Distribution = violet" before opening anything. */}
          {/* One row, sized to content. A 2-up grid forced every tab to half
              the viewport (192px each), wrapping the bar to two rows and
              pushing the range picker onto a third — ~94px of chrome above the
              data on a phone. Four short labels total ~300px, so they fit. */}
          <TabsList className="inline-flex w-auto h-auto shrink-0 gap-0.5 sm:gap-1 bg-card/80 border border-border/60 p-1 rounded-full">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className={`min-h-[40px] gap-1.5 text-xs sm:text-sm font-semibold rounded-full px-3 sm:px-4 py-1.5 whitespace-nowrap text-muted-foreground bg-transparent hover:text-foreground hover:bg-background/60 data-[state=active]:bg-background data-[state=active]:shadow-sm ${t.accent}`}
              >
                <t.icon aria-hidden="true" className="hidden min-[400px]:block h-4 w-4 shrink-0" />
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TimeRangeDropdown value={rangeDays} onChange={setRangeDays} options={visibleRangeOptions} className="shrink-0" />
        </div>
      </div>

      {/* terminal-dense is page-wide: density should be a property of this page,
          not of which control you used to get here. Before this it applied only
          to the focus view, so the same panel was compact when opened from a
          headline tile and loose when opened from the tab bar. terminal-focus
          adds the focus-only part (dropping section descriptions), which is
          only safe when the collapsed strip is there to name the metric. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={`terminal-dense focus:outline-none container mx-auto px-4 py-4 sm:py-8 max-w-7xl ${
          activeTileId ? "terminal-focus" : ""
        }`}
      >
        {/* Breadcrumb only — the page title now lives in the sticky selector
            bar above (see the title unit next to the tab pills). */}
        {/* Hidden while a tile destination is open: the main nav above already
            carries every route, and this row plus its margin is ~68px of the
            viewport that the focus view is trying to hand to the chart. It
            returns the moment the reader leaves focus mode. */}

        {/* KPI hero — the ecosystem headline. heroRef is a sentinel at its
            natural top edge: once it scrolls behind the sticky bar, the
            wrapper below pins in place (position: sticky, top = the sticky
            bar's own live bottom edge — its CSS `top` offset plus its
            height, NOT just its height, or the hero would sit under the
            bar's own top-16/md:top-20 offset and get clipped by it) and
            HolderKpiHero's tiles morph via its `collapsed` prop. Before
            that point sticky positioning is a no-op, so the hero renders in
            normal flow exactly as before. */}
        {!activeTileId && <PageIntro rangeDays={rangeDays} />}
        <div ref={heroRef} />
        {/* `position: sticky` does NOT pull this box out of document flow —
            unlike `fixed`, later siblings are laid out as if it were
            `static`, so once it's pinned, page content scrolls up and
            passes BEHIND it. Each tile card is opaque, but the grid gaps
            between them are not, so without a background on the wrapper
            itself, that scrolling content showed through those gaps —
            visible text/pills bleeding through the tile row. The mask
            follows `scrolledPast` (actually pinned), not the latched
            collapsed morph: an expanded-but-still-pinned hero still needs
            the background, and a latched-compact hero at the top of the
            page does not. */}
        <div
          className={`sticky z-30 transition-[margin] duration-200 ${heroCollapsed ? "mb-2" : "mb-5 sm:mb-6"}${scrolledPast ? " bg-background/95 backdrop-blur-md pt-1.5 pb-2 sm:pt-2 sm:pb-3 -mx-4 px-4 sm:mx-0 sm:px-0" : ""}`}
          style={{ top: stickyOffset }}
        >
          <div className="animate-fade-in" style={{ animationDelay: '0.15s' }}>
            <HolderKpiHero
              rangeDays={rangeDays}
              collapsed={heroCollapsed}
              onToggle={heroCollapse.latched ? () => dispatchHeroCollapse("toggle") : undefined}
              onTileSelect={handleTileSelect}
              activeTileId={activeTileId}
            />
          </div>
        </div>


        <TabsContent value="holders" className="mt-0 focus-visible:outline-none">
          <TabBlurb id="holders" hidden={!!activeTileId} />
          <div className="animate-fade-in" style={{ animationDelay: '0.25s' }}>
            <WalletHoldingsWidget
              // Always, not just in focus mode. The card's title block reads
              // "Holder Snapshot" under a page tab that already says Holders,
              // above a panel that carries its own heading ("Holder Growth",
              // "Balance Insights", "Exchange Flows") — three names for one
              // thing, and ~150px of them before any data on all eight panels.
              compactHeader
              panel={holderPanel}
              onPanelChange={changeHolderPanel}
              selectedView={selectedView}
              onViewChange={setSelectedView}
              rangeDays={rangeDays}
              onRangeDaysChange={setRangeDays}
              trendsPanel={
                <HolderGrowthWidget
                  selectedView={selectedView}
                  rangeDays={rangeDays}
                  onRangeDaysChange={setRangeDays}
                />
              }
              flowsPanel={<ExchangeFlowWidget rangeDays={rangeDays} />}
            />
          </div>
        </TabsContent>

        <TabsContent value="distribution" className="mt-0 focus-visible:outline-none">
          <TabBlurb id="distribution" hidden={!!activeTileId} />
          <div className="animate-fade-in" style={{ animationDelay: '0.25s' }}>
            <DistributionAnalysisWidget
              snapshot={snapshot ?? null}
              selectedView={selectedView}
              rangeDays={rangeDays}
              onRangeDaysChange={setRangeDays}
              onViewChange={setSelectedView}
            />
          </div>
        </TabsContent>

        <TabsContent value="supply" className="mt-0 focus-visible:outline-none">
          <TabBlurb id="supply" hidden={!!activeTileId} />
          <div className="animate-fade-in" style={{ animationDelay: '0.25s' }}>
            <SupplyBreakdown rangeDays={rangeDays} panel={supplyPanel} onPanelChange={changeSupplyPanel} />
          </div>
        </TabsContent>
      </main>
      </Tabs>

      <Footer />
    </div>
  );
};

export default Holders;
