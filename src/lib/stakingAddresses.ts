/**
 * Staking-program addresses a reader can open on a block explorer.
 *
 * Built from the project's methodology staking links (program, lockups,
 * stake-vault token accounts, reward vaults). Token-page links in the same
 * list are skipped — they are not accounts. Reward vaults are leftover
 * custody, not staker principal; callers can filter on `kind`.
 */
import { hasCopyText, copyText } from "@/lib/projectCopy";
import { methodologyFor } from "@/lib/methodology";
import type { ProjectConfig } from "@/lib/projects";

export type StakingAddressKind = "program" | "lockup" | "stake-vault" | "reward-vault" | "other";

export type StakingAddressLink = {
  label: string;
  address: string;
  href: string;
  kind: StakingAddressKind;
};

type LinkProject = Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "staking" | "copy">;

const ADDRESS_IN_HREF = /\/(?:account|address)\/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/;

export const stakingAddressKind = (label: string): StakingAddressKind => {
  if (/reward vault/i.test(label)) return "reward-vault";
  if (/vault ata|stake[- ]vault/i.test(label)) return "stake-vault";
  if (/program/i.test(label)) return "program";
  if (/lockup/i.test(label)) return "lockup";
  return "other";
};

/** Account links from `copy.methodology.staking.links`, in config order. */
export const stakingAddressLinks = (project: LinkProject): StakingAddressLink[] =>
  methodologyFor(project, "staking").links.flatMap((link) => {
    const match = link.href.match(ADDRESS_IN_HREF);
    if (!match) return [];
    return [{ label: link.label, address: match[1], href: link.href, kind: stakingAddressKind(link.label) }];
  });

export const fillStakedFigure = (template: string, stakedLabel: string): string =>
  template.replace(/\{staked\}/g, stakedLabel);

export type RetailStakeModel = {
  /** Secondary line under the Retail bucket, e.g. "of which 4.75B is staked". */
  note: string | null;
  /** Longer explanation for the Retail drill-down. */
  body: string | null;
  /** Program, lockups, and stake vaults — the principal credited into Retail. */
  principalLinks: StakingAddressLink[];
  /** Reward vaults — leftover custody, not staker principal. */
  rewardLinks: StakingAddressLink[];
};

/**
 * Retail-subset staking story for Supply. Absent unless the project opts in
 * with `supply.retail.stakedNote`, so TEL's supply panel stays as it is.
 */
export const supplyRetailStakeModel = (
  project: LinkProject,
  staked: number,
  format: (amount: number) => string,
): RetailStakeModel => {
  const empty: RetailStakeModel = { note: null, body: null, principalLinks: [], rewardLinks: [] };
  if (!hasCopyText(project, "supply.retail.stakedNote") || !(staked > 0)) return empty;
  const figure = format(staked);
  const links = stakingAddressLinks(project);
  return {
    note: fillStakedFigure(copyText(project, "supply.retail.stakedNote", ""), figure),
    body: hasCopyText(project, "supply.retail.stakedBody")
      ? fillStakedFigure(copyText(project, "supply.retail.stakedBody", ""), figure)
      : null,
    principalLinks: links.filter((link) => link.kind === "program" || link.kind === "lockup" || link.kind === "stake-vault"),
    rewardLinks: links.filter((link) => link.kind === "reward-vault"),
  };
};
