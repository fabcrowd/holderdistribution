import { ChevronDown } from "lucide-react";
import { useProject } from "@/hooks/useProject";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { stakingAddressLinks } from "@/lib/stakingAddresses";
import { buildViewHash } from "@/lib/viewRoute";
import { StakingAddressList } from "@/components/StakingAddressList";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * Staking Overview → Supply. Rendered only when the project explains the tie
 * (`staking.addresses.note`), so TEL's overview is unchanged.
 * One intro (staking.intro). The address note is the opt-in flag, not a second paragraph.
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
      <p className="text-sm text-foreground sm:text-base" data-testid="staking-overview-intro">
        {copy.text("staking.intro", "")}
      </p>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-sm font-semibold text-foreground">
          On-chain accounts
          <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <StakingAddressList links={links} />
        </CollapsibleContent>
      </Collapsible>
      <a
        href={buildViewHash({ view: "supply", panel: null })}
        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
      >
        Open Supply — this staked amount is inside Retail
      </a>
    </div>
  );
};
