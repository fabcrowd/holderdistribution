/**
 * Shared reading rules for the two flow feeds (exchange-flow-history.json,
 * tier-outflows.json), project-agnostic.
 *
 * Partial day: the generators flag the in-progress UTC day (`partial: true` on
 * the last exchange-flow row, `partialDate` on tier-outflows). Its hours-so-far
 * must not be totalled or ranked beside full days, and where it is shown it is
 * labelled. Feeds without the flags read as fully settled.
 *
 * Placeholder: a project whose flow scanner is not built declares the feed
 * `placeholder` in config `health.feeds` (the same switch the feed-health check
 * uses), so the panels say so instead of the generic "no data for this period".
 */
import { copyText } from "@/lib/projectCopy";
import type { ProjectConfig } from "@/lib/projects";

export const PARTIAL_DAY_LABEL = "so far today";

export const EXCHANGE_FLOW_FEED = "exchange-flow-history.json";
export const TIER_OUTFLOWS_FEED = "tier-outflows.json";

/** Rows of finished days only: drops entries the generator flagged `partial`. */
export const settledEntries = <T extends { partial?: boolean }>(entries: readonly T[]): T[] =>
  entries.filter((e) => e.partial !== true);

/** True when the tier-outflows window key covers only the in-progress day. */
export const isPartialOutflowWindow = (
  outflows: { latestDate?: string | null; partialDate?: string | null } | null | undefined,
  rangeKey: string,
): boolean => rangeKey === "1" && !!outflows?.partialDate && outflows.partialDate === outflows.latestDate;

/** True when the project declares this feed an intentional placeholder (flow tracking not built). */
export const isFlowPlaceholder = (project: Pick<ProjectConfig, "health">, file: string): boolean =>
  project.health?.feeds?.[file]?.placeholder === true;

export const FLOW_UNAVAILABLE_ID = "flows.unavailable";
export const FLOW_UNAVAILABLE_TEMPLATE = "Exchange and tier flow tracking isn't available for {ticker} yet.";

/** Empty-state copy for a placeholder flow feed; a project can override via copy.text["flows.unavailable"]. */
export const flowUnavailableText = (
  project: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy">,
): string => copyText(project, FLOW_UNAVAILABLE_ID, FLOW_UNAVAILABLE_TEMPLATE);
