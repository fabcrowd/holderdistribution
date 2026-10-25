/**
 * Chain-view keys for the Holders / Distribution / Supply widgets.
 *
 * A view is either "combined" (every chain the project is on) or one of the
 * active project's `chains[].key` values, in declaration order. Nothing here
 * hard-codes a chain: TEL resolves to combined / ethereum / polygon / base
 * exactly as before, and a project with an extra chain (e.g. arbitrum) gets
 * that view everywhere without touching a type union.
 */
import type { ProjectConfig } from "@/lib/projects";

export const COMBINED_VIEW = "combined" as const;

/** "combined" or a project chain key. `string & {}` keeps "combined" autocompletable. */
export type ChainView = typeof COMBINED_VIEW | (string & {});

export type ChainViewOption = { key: ChainView; label: string };

type ChainsOf = Pick<ProjectConfig, "chains">;

/** The project's chain keys, in config order. */
export const projectChainKeys = (project: ChainsOf): string[] =>
  (project.chains ?? []).map((c) => c.key).filter((k) => typeof k === "string" && k.length > 0 && k !== COMBINED_VIEW);

/** Every valid view for the project: "combined" first, then each chain. */
export const chainViewKeys = (project: ChainsOf): ChainView[] => [COMBINED_VIEW, ...projectChainKeys(project)];

export const isChainView = (project: ChainsOf, value: unknown): value is ChainView =>
  typeof value === "string" && chainViewKeys(project).includes(value);

/** Picker options: the combined entry (label varies by widget) plus each chain's display name. */
export const chainViewOptions = (project: ChainsOf, combinedLabel = "Combined"): ChainViewOption[] => [
  { key: COMBINED_VIEW, label: combinedLabel },
  ...(project.chains ?? [])
    .filter((c) => c.key && c.key !== COMBINED_VIEW)
    .map((c) => ({ key: c.key, label: c.name || c.key })),
];

/** Display label for a view; unknown keys fall back to the key itself. */
export const chainViewLabel = (project: ChainsOf, view: ChainView, combinedLabel = "Combined"): string =>
  chainViewOptions(project, combinedLabel).find((o) => o.key === view)?.label ?? view;

/** The view if the project has it, else "combined" (e.g. after switching project). */
export const coerceChainView = (project: ChainsOf, view: unknown): ChainView =>
  isChainView(project, view) ? view : COMBINED_VIEW;

/**
 * Note for the Staked tile on a chain with no staking contract: names the
 * chain(s) staking runs on (TEL: "Staking runs on Polygon"). Null on the
 * combined view, on a staking chain, or when the project has no staking.
 */
export const stakingElsewhereNote = (
  project: Pick<ProjectConfig, "chains" | "staking">,
  view: ChainView,
): string | null => {
  if (view === COMBINED_VIEW) return null;
  const stakingChains = [...new Set((project.staking ?? []).map((s) => s.chain).filter(Boolean))];
  if (stakingChains.length === 0 || stakingChains.includes(view)) return null;
  const names = stakingChains.map((k) => (project.chains ?? []).find((c) => c.key === k)?.name ?? k);
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Staking runs on ${list}`;
};
