import { ExplainNumber } from "./ExplainNumber";
import { walletColumns, netChangeTip, type WalletColumnKey } from "./columnCopy";

// Same 44px hit-area pattern as the legend: the visible label stays 24px tall,
// a pseudo-element grows the touch target below xl.
const TRIGGER =
  "inline-flex min-h-6 items-center whitespace-nowrap max-xl:min-w-11 max-xl:justify-center max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-2 max-xl:before:-inset-y-2.5 max-xl:before:content-['']";

const Trigger = ({ label, tip }: { label: string; tip: string }) => (
  <ExplainNumber value={label} explanation={tip} ariaLabel={`${label}: what this column means`} className={TRIGGER} />
);

/** Anchor x (canvas px) per column; rendered at unscaled 12px over the scaled canvas. */
export type ColumnAnchors = Record<WalletColumnKey, number>;

/** `visibility` flips at the end of a fade-out and at the start of a fade-in, so hidden headers leave the tab order. */
const FADE = "transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none";
const SHOWN = "opacity-100 visible";
const HIDDEN = "opacity-0 invisible pointer-events-none";

export const WalletColumnHeaders = ({
  period, ticker, anchors, scale, originX, netMode = false, netAnchor,
}: {
  /** Window phrase from columnCopy.periodPhrase. */
  period: string; ticker: string; anchors: ColumnAnchors; scale: number; originX: number;
  /** A tier or side tile is selected: Joined / Left fade out, Net fades in over `netAnchor`. */
  netMode?: boolean; netAnchor?: number;
}) => {
  const cols = walletColumns(period, ticker);
  return (
    <div className="relative h-7 text-xs font-medium text-muted-foreground" data-testid="wallet-column-headers">
      {(["joined", "wallets", "left"] as const).map((k) => {
        const fades = k !== "wallets";
        return (
          <span
            key={k}
            aria-hidden={fades && netMode ? true : undefined}
            data-testid={fades ? `wallet-column-${k}` : undefined}
            className={`absolute top-0.5 -translate-x-1/2 ${fades ? `${FADE} ${netMode ? HIDDEN : SHOWN}` : ""}`}
            style={{ left: (anchors[k] - originX) * scale }}
          >
            <Trigger label={cols[k].label} tip={cols[k].tip} />
          </span>
        );
      })}
      {netAnchor != null && (
        <span
          aria-hidden={netMode ? undefined : true}
          data-testid="wallet-column-net"
          className={`absolute top-0.5 -translate-x-1/2 ${FADE} ${netMode ? SHOWN : HIDDEN}`}
          style={{ left: (netAnchor - originX) * scale }}
        >
          <Trigger label="Net" tip={netChangeTip(period)} />
        </span>
      )}
    </div>
  );
};

export const PhoneListHeader = ({ period, ticker }: { period: string; ticker: string }) => {
  const cols = walletColumns(period, ticker);
  return (
    <div className="flex items-center justify-between px-3 text-xs font-medium text-muted-foreground" data-testid="wallet-list-header">
      <span className="inline-flex items-center gap-3">
        <span>Tier</span>
        <Trigger label="In / out" tip={`${cols.joined.tip} ${cols.left.tip}`} />
      </span>
      <Trigger label={cols.wallets.label} tip={cols.wallets.tip} />
    </div>
  );
};
