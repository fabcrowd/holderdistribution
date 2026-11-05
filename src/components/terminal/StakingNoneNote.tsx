import { useProject } from "@/hooks/useProject";
import { stakingNoneText } from "@/lib/stakingNote";
import { PanelMessage } from "./TerminalPanel";

/** Body of the Staked panel for a token with no staking mechanism (see lib/stakingNote.ts). */
export const StakingNoneNote = () => {
  const { project } = useProject();
  return (
    <PanelMessage>
      <span data-testid="staking-none">{stakingNoneText(project)}</span>
    </PanelMessage>
  );
};
