/**
 * URL hash <-> page view. One source of truth for deep links:
 *
 *   #holders               Holders dashboard (desktop) / default panel (mobile)
 *   #holders/flows         a specific Holders panel (desktop opens Explore)
 *   #distribution          Distribution
 *   #supply/wallet-flows   a specific Supply panel
 *
 * "#overview" was a real tab until 2026-09-13 and still appears in shared
 * links, so it resolves to Holders. Any other hash (e.g. the skip link's
 * "#main-content") is NOT a view and returns null so callers can ignore it
 * instead of bouncing the reader back to the default tab.
 */
export const VIEW_IDS = ["holders", "distribution", "supply"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const HOLDER_PANEL_IDS = [
  "overview",
  "concentration",
  "balances",
  "staking",
  "growth",
  "trends",
  "flows",
  "exchanges",
] as const;
export const SUPPLY_PANEL_IDS = ["breakdown", "reconciliation", "history", "wallet-flows"] as const;

export const DEFAULT_PANEL: Record<ViewId, string | null> = {
  holders: "trends",
  distribution: null,
  supply: "breakdown",
};

export type ViewRoute = { view: ViewId; panel: string | null };

export const isViewId = (v: string): v is ViewId => (VIEW_IDS as readonly string[]).includes(v);

export const panelIdsFor = (view: ViewId): readonly string[] =>
  view === "holders" ? HOLDER_PANEL_IDS : view === "supply" ? SUPPLY_PANEL_IDS : [];

export const parseViewHash = (hash: string): ViewRoute | null => {
  const raw = hash.replace(/^#/, "").trim().toLowerCase();
  if (!raw) return { view: "holders", panel: null };
  const [first, second] = raw.split("/");
  const view = first === "overview" ? "holders" : first;
  if (!isViewId(view)) return null;
  const panel = second && panelIdsFor(view).includes(second) ? second : null;
  return { view, panel };
};

export const buildViewHash = ({ view, panel }: ViewRoute): string =>
  panel && panelIdsFor(view).includes(panel) ? `#${view}/${panel}` : `#${view}`;
