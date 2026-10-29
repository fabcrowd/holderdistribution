import { useProject } from "@/hooks/useProject";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { stakingAddressLinks } from "@/lib/stakingAddresses";
import { buildViewHash } from "@/lib/viewRoute";
import { StakingAddressList } from "@/components/StakingAddressList";

/**
 * Staking Overview → Supply. Rendered only when the project explains the tie
 * (`staking.addresses.note`), so TEL's overview is unchanged.
 */
export const StakingSupplyTie = () => {
  const { project } = useProject();
  const copy = useProjectCopy();
  if (!copy.hasText("staking.addresses.note")) return null;
  const links = stakingAddressLinks(project);
  if (links.length === 0) return null;
  return (
    <div
      data-testid="staking-supply-tie"
      className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3 sm:p-4"
    >
      <p className="text-sm text-muted-foreground">{copy.text("staking.addresses.note", "")}</p>
      <StakingAddressList links={links} />
      <a
        href={buildViewHash({ view: "supply", panel: null })}
        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
      >
        Open Supply — this staked amount is inside Retail
      </a>
    </div>
  );
};
