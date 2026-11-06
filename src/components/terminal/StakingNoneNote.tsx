import { useProject } from "@/hooks/useProject";
import { stakingNoneText } from "@/lib/stakingNote";
import { Card, CardContent } from "@/components/ui/card";
import { PanelMessage } from "./TerminalPanel";

/** The mobile Staking section for a token with no staking mechanism: the note in place of zeroed stat tiles. */
export const StakingNoneCard = () => (
  <Card className="premium-surface-card" data-testid="staking-none-card">
    <CardContent className="py-6">
      <StakingNoneNote />
    </CardContent>
  </Card>
);

/** Body of the Staked panel for a token with no staking mechanism (see lib/stakingNote.ts). */
export const StakingNoneNote = () => {
  const { project } = useProject();
  return (
    <PanelMessage>
      <span data-testid="staking-none">{stakingNoneText(project)}</span>
    </PanelMessage>
  );
};
