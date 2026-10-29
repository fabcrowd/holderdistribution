import type { EcosystemHeadlineTile, EcosystemHeadlineTileId } from "@/hooks/useEcosystemHeadlineTiles";

/**
 * The three questions the desktop hero answers, in reading order: how many
 * people hold it, how much of it they hold, how much sits on exchanges.
 * Staked is the project-specific fourth tile; it lives in the Details
 * accordion instead. The tiles themselves come from the project registry via
 * useEcosystemHeadlineTiles, so nothing here names a token.
 */
export const ANSWER_CARD_IDS: readonly EcosystemHeadlineTileId[] = ["holders", "retailHeld", "cex"];

export const pickAnswerTiles = (tiles: readonly EcosystemHeadlineTile[]): EcosystemHeadlineTile[] =>
  ANSWER_CARD_IDS.flatMap((id) => tiles.filter((t) => t.id === id));
