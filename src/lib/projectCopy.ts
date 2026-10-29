/**
 * Project-driven UI copy. Widgets, tooltips, intros and the glossary are
 * written once as templates and filled from the active project's config
 * (config/projects/<slug>.json), so the Holders / Distribution / Supply
 * terminals read correctly for any mapped token, not just TEL.
 *
 * Placeholders:
 *   {ticker}  e.g. "TEL"
 *   {name}    e.g. "Telcoin"
 *   {chains}  e.g. "Ethereum, Polygon and Base" (from config chains[])
 *   {supply}  e.g. "100B" (supply.targetLabel or derived from supply.target)
 *
 * Project-specific facts that have no generic phrasing (named custodians, a
 * token upgrade, a staking migration, a one-off relabel) live in the project
 * config: `copy.glossary` overrides a glossary term, `copy.text` overrides a
 * widget string by id (see copyText). The generic template is the fallback,
 * so a new project reads correctly with no copy section at all.
 */
import { supplyTargetLabel, type ProjectConfig } from "@/lib/projects";

export type CopyContext = {
  ticker: string;
  name: string;
  chains: string;
  supply: string;
};

/** "A", "A and B", "A, B and C" — the house style used across the site. */
export const joinList = (items: readonly string[]): string => {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};

export const copyContext = (
  p: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply">,
): CopyContext => ({
  ticker: p.ticker,
  name: p.name,
  chains: joinList((p.chains ?? []).map((c) => c.name)) || "every supported chain",
  supply: supplyTargetLabel(p) ?? "total",
});

const PLACEHOLDER = /\{(ticker|name|chains|supply)\}/g;

/** Fills {ticker}/{name}/{chains}/{supply}. Unknown braces are left alone. */
export const fillCopy = (template: string, ctx: CopyContext): string =>
  template.replace(PLACEHOLDER, (_, key: keyof CopyContext) => ctx[key]);

/** True when the project tracks more than one token generation (e.g. legacy + v3). */
export const hasTokenGenerations = (p: Pick<ProjectConfig, "chains">): boolean =>
  new Set((p.chains ?? []).flatMap((c) => c.tokens.map((t) => t.generation))).size > 1;

/**
 * A widget string by id: the project's `copy.text[id]` override when it has
 * one, else the generic template. Either way placeholders are filled.
 */
export const copyText = (
  project: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy">,
  id: string,
  template: string,
): string => fillCopy(project.copy?.text?.[id] ?? template, copyContext(project));

/** True when the project overrides widget string `id` (for copy that only makes sense with project facts). */
export const hasCopyText = (project: Pick<ProjectConfig, "copy">, id: string): boolean =>
  typeof project.copy?.text?.[id] === "string";

/** `copy.text` entries whose id starts with `prefix`, filled; `suffix` is the id after the prefix. Sorted by suffix. */
export const copyTextsByPrefix = (
  project: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy">,
  prefix: string,
): { suffix: string; text: string }[] =>
  Object.keys(project.copy?.text ?? {})
    .filter((id) => id.startsWith(prefix))
    .sort()
    .map((id) => ({ suffix: id.slice(prefix.length), text: copyText(project, id, "") }));

/**
 * Names for the project-controlled entities on the Supply view. The pie uses
 * one bucket set (Treasury, Team, Holdings, …). These slots are the display
 * names for Treasury (`entity.association`) and Holdings (`entity.holdings`).
 * Defaults are the canonical words; a project overrides them (TEL: Association
 * safes vs Telcoin Holdings — two entities that are never summed).
 */
export type ProjectEntities = {
  /** Treasury slice title, e.g. "Telcoin Association-Controlled Safes". */
  association: string;
  /** Short prefix, e.g. "Association" ("Association Safes", "Association — Treasury"). */
  associationShort: string;
  /** Holdings slice title, e.g. "Telcoin Holdings". */
  holdings: string;
  /** Short form, e.g. "Holdings". */
  holdingsShort: string;
};

export const ENTITY_TEMPLATES: Record<keyof ProjectEntities, string> = {
  association: "Treasury",
  associationShort: "Treasury",
  holdings: "Holdings",
  holdingsShort: "Holdings",
};

export const projectEntities = (
  project: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy">,
): ProjectEntities => ({
  association: copyText(project, "entity.association", ENTITY_TEMPLATES.association),
  associationShort: copyText(project, "entity.associationShort", ENTITY_TEMPLATES.associationShort),
  holdings: copyText(project, "entity.holdings", ENTITY_TEMPLATES.holdings),
  holdingsShort: copyText(project, "entity.holdingsShort", ENTITY_TEMPLATES.holdingsShort),
});
