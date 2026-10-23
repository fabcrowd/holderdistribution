import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  useEcosystemHeadlineTiles,
  type HeadlineView,
  type EcosystemHeadlineTileId,
} from "@/hooks/useEcosystemHeadlineTiles";
import { useHolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { InfoTooltip } from "@/components/InfoTooltip";

/**
 * A headline tile that is also a destination.
 *
 * The hit area is an absolutely-positioned button UNDERNEATH the content, not
 * a button wrapped around it. Wrapping was the obvious version and it is
 * invalid: these tiles already contain buttons of their own (the info tooltip,
 * the changelog marker inside ChangeIndicator), and a <button> inside a
 * <button> is malformed DOM that browsers recover from unpredictably — caught
 * by a validateDOMNesting error in the browser test, not by tsc.
 *
 * So the content layer is made transparent to pointer events and the nested
 * controls opt back in, which lets a click anywhere on the tile reach the
 * overlay while the tooltip still takes its own clicks. A real <button>
 * element keeps focus, Enter and Space without re-implementing any of it.
 */
const TileShell = ({
  onSelect,
  active,
  label,
  className,
  children,
}: {
  onSelect?: () => void;
  active: boolean;
  label: string;
  className: string;
  children: ReactNode;
}) => {
  if (!onSelect) return <div className={className}>{children}</div>;
  return (
    <div
      className={`${className} ${
        active ? "ring-1 ring-primary/40" : "hover:bg-foreground/[0.03]"
      } focus-within:outline-none focus-within:ring-2 focus-within:ring-ring`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        aria-label={`Show ${label} charts`}
        className="absolute inset-0 z-0 cursor-pointer focus:outline-none"
      />
      <div className="relative pointer-events-none [&_button]:pointer-events-auto [&_a]:pointer-events-auto">
        {children}
      </div>
    </div>
  );
};

/**
 * Always-visible ecosystem headline: the four numbers a reader should see
 * first, for the combined (all-chain) view. The detailed, chain-switchable and
 * range-aware breakdowns live in the sections below. Values come from
 * useEcosystemHeadlineTiles so this and any other consumer can never disagree.
 *
 * `collapsed` drives the pinned/scrolled state once this hero reaches the
 * sticky selector bar (see Holders.tsx): the header (icon+label) and
 * subtitle rows collapse away via the shared `.headline-collapse` grid-rows
 * technique, while the value row's own size never changes — only a second,
 * small icon anchor cross-fades in beside it, approximating the header's
 * icon "relocating" next to the number without a shared-element library.
 *
 * After the first collapse, Holders.tsx latches that state so scrolling back
 * up does not replay the expand animation. `onToggle` is passed once latched
 * so a click (chevron, or the compact strip itself) can reopen it.
 */
const HeroSkeleton = () => (
  <div aria-hidden="true" data-testid="hero-skeleton">
    <div className="mb-3 h-4 w-28 rounded bg-muted/70 animate-pulse" />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="premium-surface-card p-2.5 sm:p-6 space-y-2.5">
          <div className="h-3 w-20 rounded bg-muted/70 animate-pulse" />
          <div className="h-7 w-24 rounded bg-muted/80 animate-pulse" />
          <div className="h-3 w-32 max-w-full rounded bg-muted/60 animate-pulse" />
        </div>
      ))}
    </div>
  </div>
);

export const HolderKpiHero = ({
  rangeDays,
  collapsed = false,
  onToggle,
  onTileSelect,
  activeTileId = null,
  view = "combined",
}: {
  rangeDays: number;
  /** Header chain selector; per-chain values where the feed splits them. */
  view?: HeadlineView;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Makes each tile a destination: clicking one collapses the hero and opens
   *  that metric's charts. Without it the tiles stay plain readouts. */
  onTileSelect?: (id: EcosystemHeadlineTileId) => void;
  activeTileId?: EcosystemHeadlineTileId | null;
}) => {
  const result = useEcosystemHeadlineTiles(rangeDays, view);
  const { isError: liteError } = useHolderLiteSnapshot();
  // Reserve the tiles' space while the snapshot loads. Returning null here
  // made the whole first screen jump once data arrived (the hero popped in
  // above the already-rendered panel), and an empty page reads as broken.
  // ...but once the snapshot has definitively failed, a skeleton would pulse
  // forever; the panel below carries the error and a retry instead.
  if (!result) return liteError ? null : <HeroSkeleton />;
  const { tiles } = result;

  const toggleControl = onToggle ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand headline numbers" : "Collapse headline numbers"}
      className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronDown
        className={`h-5 w-5 transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`}
      />
    </button>
  ) : null;

  return (
    <div
      onClick={collapsed && onToggle && !onTileSelect ? onToggle : undefined}
      className={collapsed && onToggle && !onTileSelect ? "cursor-pointer" : undefined}
    >
      {/* Caption row: redundant chrome once pinned — the chain scope and
          range are already legible from the tab bar/YTD selector directly
          above at that point, so collapsing this too keeps the pinned bar
          as small as the numbers it exists to show. The toggle chevron
          stays visible after the first latch so a collapsed strip can be
          reopened without scrolling. */}
      <div className={`headline-collapse ${collapsed ? "" : "is-open"}`}>
        <div>
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <h2 className="text-xs uppercase tracking-[0.14em] font-bold text-muted-foreground">At a glance</h2>
            <MethodologyInfo section="holderSnapshot" />
            {/* This hero is always combined-only, unlike the chain-switchable
                Holder Snapshot section below it — without this, switching that
                section to a single chain looks like it should change these
                numbers too, when it never does. */}
            <span className="text-[10px] sm:text-xs font-medium text-muted-foreground border border-border/60 rounded-full px-2 py-0.5">
              All chains — Ethereum + Polygon + Base
            </span>
            <span className="ml-auto flex items-center gap-1">
              {!collapsed ? toggleControl : null}
            </span>
          </div>
        </div>
      </div>
      {/* Collapsed on a phone, this drops to a bare one-line strip — four
          across, icon + value only, no card chrome and no delta pills. The
          card morph (and the "value/delta never change size" rule the morph
          was built around) is kept from sm up, where there's width for it;
          below sm those cards were a 2x2 grid whose value row wrapped its
          delta onto a second line, so the pinned header cost ~170px on the
          screen least able to spare it. */}
      <div className={collapsed && toggleControl ? "flex items-center gap-1" : undefined}>
      <div className={`min-w-0 flex-1 grid transition-[gap] duration-200 ${collapsed ? "grid-cols-4 gap-2" : "grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4"}`}>
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <TileShell
              key={t.id}
              onSelect={onTileSelect ? () => onTileSelect(t.id) : undefined}
              active={activeTileId === t.id}
              label={t.label}
              className={`relative overflow-hidden transition-[padding] duration-200 ${collapsed ? "p-0 sm:px-3 sm:py-2 sm:premium-surface-card" : "premium-surface-card p-2.5 sm:p-6"}`}
            >
              {/* The top rule doubles as the selected-state marker: full-width
                  and solid on the active tile, the usual fading gradient
                  otherwise. One element carrying both states means the active
                  tile never grows or shifts relative to its neighbours. */}
              <span className={`absolute inset-x-0 top-0 h-[3px] ${activeTileId === t.id ? "bg-primary" : "bg-gradient-to-r from-primary to-primary/40"} ${collapsed ? "hidden" : ""}`} />
              <div className={`headline-collapse ${collapsed ? "" : "is-open"}`}>
                <div>
                  <div className="flex items-center gap-1.5 sm:gap-2 mb-1.5 sm:mb-3">
                    <Icon className={`h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary shrink-0 transition-[opacity,transform] duration-200 ${collapsed ? "opacity-0 -translate-x-1" : "opacity-100 translate-x-0"}`} />
                    <span className="text-[10px] sm:text-[11px] uppercase tracking-wide font-bold text-muted-foreground">{t.label}</span>
                    {t.infoTooltip && <InfoTooltip text={t.infoTooltip} />}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                {/* Second icon anchor: present at all times, cross-fades in as
                    the header's own icon (above) fades out, so the icon reads
                    as having relocated next to the value instead of a new
                    element appearing. */}
                <Icon className={`h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary shrink-0 transition-[opacity,transform] duration-200 ${collapsed ? "opacity-100 translate-x-0" : "opacity-0 translate-x-1 w-0 -ml-2"}`} />
                <span className={`font-extrabold tracking-tight text-foreground tabular-nums ${collapsed ? "text-sm sm:text-xl" : "text-xl sm:text-[2rem]"}`}>{t.value}</span>
                {t.current !== null && (
                  <span className={collapsed ? "hidden lg:inline-flex" : "inline-flex"}>
                    <ChangeIndicator current={t.current} previous={t.previous} formatter={t.fmt} size="md" tone={t.tone ?? "auto"} changelogEvents={t.changelogEvents} />
                  </span>
                )}
                {t.ath && (
                  <span className={`text-[10px] font-extrabold tracking-wide text-emerald-700 dark:text-emerald-400 border border-emerald-500/40 rounded-full px-2 py-0.5 ${collapsed ? "hidden lg:inline" : ""}`}>ATH</span>
                )}
              </div>
              <div className={`headline-collapse ${collapsed ? "" : "is-open"}`}>
                <div>
                  <div className={`text-[11px] sm:text-xs mt-1 sm:mt-1.5 leading-snug ${t.ath ? "text-emerald-700 dark:text-emerald-400 font-semibold" : "text-muted-foreground"}`}>{t.sub}</div>
                </div>
              </div>
            </TileShell>
          );
        })}
      </div>
      {collapsed ? toggleControl : null}
      </div>
    </div>
  );
};
