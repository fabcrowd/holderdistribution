import { ChevronDown } from "lucide-react";
import { useProject } from "@/hooks/useProject";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { stakingAddressLinks } from "@/lib/stakingAddresses";
import { buildViewHash } from "@/lib/viewRoute";
import { InfoTip } from "@/components/InfoTip";
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
  const intro = copy.text("staking.intro", "");
  // Below md only the first sentence stays visible; the full paragraph is in the (i).
  const cut = intro.indexOf(". ");
  const lead = cut > 0 && cut + 1 < intro.length ? intro.slice(0, cut + 1) : null;
  return (
    <div
      data-testid="staking-supply-tie"
      className="min-w-0 max-w-full space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3 sm:p-4"
    >
      <p
        className={`text-sm text-foreground sm:text-base ${lead ? "hidden md:block" : ""}`}
        data-testid="staking-overview-intro"
      >
        {intro}
      </p>
      {lead && (
        <p className="flex items-start gap-1 text-sm text-foreground md:hidden" data-testid="staking-overview-lead">
          <span className="min-w-0">{lead}</span>
          <InfoTip content={intro} label="About staking" side="bottom" align="end" className="max-xl:mt-0.5" />
        </p>
      )}
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-sm font-semibold text-foreground max-xl:min-h-11">
          On-chain accounts
          <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <StakingAddressList links={links} />
        </CollapsibleContent>
      </Collapsible>
      <a
        href={buildViewHash({ view: "supply", panel: null })}
        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline max-xl:min-h-11"
      >
        Open Supply — this staked amount is inside Retail
      </a>
    </div>
  );
};
