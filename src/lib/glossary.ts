/**
 * Plain-language definitions for the terms this dashboard uses. Rendered by
 * GlossaryDialog (header button) and reused for inline tooltips, so a term is
 * explained the same way wherever it appears.
 *
 * Definitions are project-agnostic templates ({ticker}, {name}, {chains},
 * {supply}; see projectCopy.ts) filled from the active project's config.
 * Facts only one project has (named custodians, a token upgrade) come from
 * that project's `copy.glossary` overrides in config/projects/<slug>.json.
 * The "legacy-v3" term is only listed for projects with more than one token
 * generation.
 */
import { DEFAULT_PROJECT_SLUG, getProject, type ProjectConfig } from "@/lib/projects";
import { copyContext, fillCopy, hasTokenGenerations } from "@/lib/projectCopy";

export type GlossaryTerm = { id: string; term: string; definition: string };

/** Generic templates. Order is the display order. */
export const GLOSSARY_TEMPLATES: readonly GlossaryTerm[] = [
  {
    id: "retail",
    term: "Retail holder",
    definition:
      "Any wallet holding more than 0 {ticker} that is not an exchange, DEX pool, {name} treasury/escrow wallet or a known contract. Roughly: individual holders.",
  },
  {
    id: "legacy-v3",
    term: "Token generations",
    definition:
      "{ticker} exists as more than one token contract. Balances here add every generation so an upgrade never looks like a sale, and total supply stays at {supply}.",
  },
  {
    id: "supply",
    term: "Total supply ({supply})",
    definition:
      "The fixed {ticker} supply. Bridged copies on other chains are backed by tokens locked at the source, so each token is counted once.",
  },
  {
    id: "cex",
    term: "CEX",
    definition:
      "Centralised exchange. CEX balance is {ticker} sitting in exchange-controlled wallets. Moving {ticker} to an exchange is often, but not always, a step before selling.",
  },
  {
    id: "dex",
    term: "DEX",
    definition:
      "Decentralised exchange (e.g. Uniswap). {ticker} in DEX pools is liquidity that traders buy from and sell into.",
  },
  {
    id: "escrow",
    term: "Escrow & custody",
    definition:
      "{ticker} held by custodians or escrow contracts. It is not circulating and is excluded from retail figures.",
  },
  {
    id: "staked",
    term: "Staked {ticker}",
    definition: "{ticker} locked in the {name} staking contract.",
  },
  {
    id: "tier",
    term: "Balance tier",
    definition:
      "A band of wallet sizes (e.g. 1M–5M {ticker}). The Distribution tab shows how many wallets moved between tiers and whether {ticker} entered or left each tier.",
  },
  {
    id: "snapshot",
    term: "Snapshot",
    definition:
      "A point-in-time scan of every {ticker} balance on {chains}. Snapshots refresh daily; the date in the header shows how current the numbers are.",
  },
  {
    id: "reclassified",
    term: "Relabeled",
    definition:
      "Shown instead of a change when a wallet was reclassified during the period (e.g. later identified as an exchange). The raw difference would mix real movement with a bookkeeping change.",
  },
];

/** The glossary for one project: templates filled + that project's overrides. */
export const buildGlossary = (project: ProjectConfig): GlossaryTerm[] => {
  const ctx = copyContext(project);
  const overrides = project.copy?.glossary ?? {};
  const multiGen = hasTokenGenerations(project);
  return GLOSSARY_TEMPLATES.filter((t) => t.id !== "legacy-v3" || multiGen).map((t) => {
    const o = overrides[t.id];
    return {
      id: t.id,
      term: fillCopy(o?.term ?? t.term, ctx),
      definition: fillCopy(o?.definition ?? t.definition, ctx),
    };
  });
};

/** Default project's glossary (kept for callers outside React). */
export const GLOSSARY: GlossaryTerm[] = buildGlossary(getProject(DEFAULT_PROJECT_SLUG));

export const glossaryTerm = (id: string, glossary: readonly GlossaryTerm[] = GLOSSARY): GlossaryTerm | undefined =>
  glossary.find((t) => t.id === id);
