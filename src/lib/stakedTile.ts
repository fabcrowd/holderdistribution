/**
 * Copy for the Staked headline tile: the sub-line under the amount and the
 * (i) tooltip. The tooltip carries the detail (chain, shares); the sub-line
 * stays one short line so the tile reads at 390px.
 */

/** part / whole as a fraction, or null when the whole is unknown or zero. */
export const shareOf = (part: number, whole: number | null | undefined): number | null =>
  typeof whole === "number" && Number.isFinite(whole) && whole > 0 ? part / whole : null;

const percent = (share: number | null): string | null => (share === null ? null : `${(share * 100).toFixed(2)}%`);

export type StakedTileCopyInput = {
  ticker: string;
  /** Chain(s) the project-wide total lives on; null when the figure is this view's own. */
  projectWideWhere: string | null;
  staked: number;
  retailBalance: number | null | undefined;
  totalSupply: number | null | undefined;
};

export type StakedTileCopy = { sub: string; tooltip: string };

export const stakedTileCopy = ({ ticker, projectWideWhere, staked, retailBalance, totalSupply }: StakedTileCopyInput): StakedTileCopy => {
  const ofRetail = percent(shareOf(staked, retailBalance));
  const ofSupply = percent(shareOf(staked, totalSupply));
  const sub = projectWideWhere
    ? [`On ${projectWideWhere}`, ofSupply && `${ofSupply} of supply`].filter(Boolean).join(" · ")
    : [ofRetail && `${ofRetail} of retail`, ofSupply && `${ofSupply} of supply`].filter(Boolean).join(" · ");
  const where = projectWideWhere ? `Staked ${ticker} is held on ${projectWideWhere}. ` : "";
  const retail = ofRetail ? `${ofRetail} of retail ${ticker} balance.` : "";
  return { sub, tooltip: `${where}${retail}`.trim() };
};
