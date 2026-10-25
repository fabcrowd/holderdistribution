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
