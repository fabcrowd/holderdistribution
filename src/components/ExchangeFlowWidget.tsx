import { MethodologyInfo } from "@/components/MethodologyInfo";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { ExchangeNetflow } from "@/components/ExchangeNetflow";
import { ArrowLeftRight } from "lucide-react";

type ExchangeFlowWidgetProps = {
  rangeDays: number;
};

/**
 * The measured exchange-flow chart, rendered as a sub-panel of the Holder
 * Snapshot selector.
 *
 * ExchangeNetflow used to render buried inside WalletHoldingsWidget's CEX Flow
 * Snapshot — below a long per-exchange table, inside a collapsed section — even
 * though it is the only series on this page that reclassification cannot move.
 * Balance charts are an inventory: relabelling an address (the KuCoin vaults,
 * ~8.69B TEL) shifts TEL between buckets with nothing moving on-chain. This
 * counts transfers, so it answers "did TEL actually move toward the market?"
 * — which is the question behind most price moves.
 *
 * It carries no Card/Collapsible chrome of its own any more: the panel
 * selector already does the showing and hiding, and a collapse control inside
 * a control that already selects it is duplicated navigation — the same call
 * already made for the three tab-level widgets.
 */
export const ExchangeFlowWidget = ({ rangeDays }: ExchangeFlowWidgetProps) => {
  const { ticker } = useProjectCopy();
  return (
  <div>
    <div className="flex items-center gap-2 text-base sm:text-lg font-bold tracking-tight flex-wrap">
      <span className="p-1.5 rounded-xl bg-amber-500/12 border border-amber-500/20 shrink-0">
        <ArrowLeftRight className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      </span>
      Exchange Flows
      <MethodologyInfo section="cexFlows" />
          </div>
    <p data-panel-desc className="text-sm text-muted-foreground mt-1.5">
      {ticker} actually moving to and from exchanges, counted from Transfer logs. Unlike the
      balance charts, this is unaffected by how a wallet is categorised.
    </p>
    <div className="pt-4">
      <ExchangeNetflow rangeDays={rangeDays} />
    </div>
  </div>
  );
};
