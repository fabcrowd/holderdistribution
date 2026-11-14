import { useProject } from "@/hooks/useProject";
import { stakingNoneText } from "@/lib/stakingNote";
import type { NetworkStake } from "@/lib/staking";
import { Card, CardContent } from "@/components/ui/card";
import { NetworkStakeTile } from "./NetworkStakeTile";
import { PanelMessage } from "./TerminalPanel";

/**
 * The mobile Staking section for a token with no staking contract: the note in place of zeroed stat tiles,
 * or the network staked tile when the feed carries one.
 */
export const StakingNoneCard = ({ networkStake = null }: { networkStake?: NetworkStake | null }) => (
  <Card className="premium-surface-card" data-testid="staking-none-card">
    <CardContent className="py-6">
      <StakingNoneNote networkStake={networkStake} />
    </CardContent>
  </Card>
);

/**
 * Body of the Staked panel for a token with no staking contract (see lib/stakingNote.ts). A native coin
 * with network-level staking shows its informational tile instead of the "no staking" note.
 */
export const StakingNoneNote = ({ networkStake = null }: { networkStake?: NetworkStake | null }) => {
  const { project } = useProject();
  if (networkStake) return <NetworkStakeTile stake={networkStake} />;
  return (
    <PanelMessage>
      <span data-testid="staking-none">{stakingNoneText(project)}</span>
    </PanelMessage>
  );
};
