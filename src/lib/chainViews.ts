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

/** Staking chain keys from config `staking[].chain`, in config order, de-duplicated. */
export const stakingChainKeys = (project: Pick<ProjectConfig, "chains" | "staking">): string[] => {
  const chainKeys = new Set(projectChainKeys(project));
  const stakingKeys = (project.staking ?? []).map((s) => s.chain).filter((k) => chainKeys.has(k));
  return [...new Set(stakingKeys)];
};

/** Display names of the staking chains: "Polygon", "Polygon and Base". */
const stakingChainNames = (project: Pick<ProjectConfig, "chains" | "staking">): string => {
  const names = stakingChainKeys(project).map((k) => (project.chains ?? []).find((c) => c.key === k)?.name ?? k);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * Where the Staked tile's figure comes from on a chain view.
 * - `none`: the project has no staking in config, so there is no Staked tile.
 * - `view`: measured on this view (the combined view, or a chain that holds staking).
 * - `projectWide`: this chain holds no staking, so the tile shows the project-wide
 *   total, labelled with the chain(s) it lives on (TEL Ethereum: "Polygon").
 */
export type StakedScope = { kind: "none" } | { kind: "view" } | { kind: "projectWide"; where: string };

export const stakedScope = (project: Pick<ProjectConfig, "chains" | "staking">, view: ChainView): StakedScope => {
  const stakingKeys = stakingChainKeys(project);
  if (stakingKeys.length === 0) return { kind: "none" };
  if (view === COMBINED_VIEW || stakingKeys.includes(view)) return { kind: "view" };
  return { kind: "projectWide", where: stakingChainNames(project) };
};
