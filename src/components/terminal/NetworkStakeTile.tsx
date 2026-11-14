import { useProject } from "@/hooks/useProject";
import { COMPACT_TOKEN_AMOUNT, formatCompact } from "@/lib/format";
import { NETWORK_STAKE_NOTE, NETWORK_STAKE_UNAVAILABLE, networkStakeTile, type NetworkStake } from "@/lib/staking";
import { PanelMessage } from "./TerminalPanel";

/**
 * The one informational Staking tile for a native coin whose feed carries the network's staked amount.
 * Shows the amount, its share of total supply and the staking period it describes. No staker count, no
 * wallet list, no chart: the feed has none of that. The note says why this is not subtracted from anything.
 */
export const NetworkStakeTile = ({ stake }: { stake: NetworkStake }) => {
  const { project } = useProject();
  const tile = networkStakeTile(stake, project.supply?.target);
  if (tile.kind === "unavailable") {
    return (
      <PanelMessage>
        <span data-testid="network-stake-unavailable">{NETWORK_STAKE_UNAVAILABLE}</span>
      </PanelMessage>
    );
  }
  return (
    <div data-testid="network-stake" className="premium-surface-card mx-auto max-w-md space-y-1 p-4 text-center">
      <div className="text-xs font-semibold text-muted-foreground">Staked on the network</div>
      <div className="text-xl font-semibold text-primary" data-testid="network-stake-amount">{formatCompact(tile.amount, COMPACT_TOKEN_AMOUNT)}</div>
      {tile.shareOfSupply != null && (
        <div className="text-xs tabular-nums text-muted-foreground">{(tile.shareOfSupply * 100).toFixed(2)}% of total supply</div>
      )}
      <div className="text-xs tabular-nums text-muted-foreground">Staking period of {tile.periodDay} (UTC)</div>
      <p className="pt-2 text-xs text-muted-foreground">{NETWORK_STAKE_NOTE}</p>
    </div>
  );
};
