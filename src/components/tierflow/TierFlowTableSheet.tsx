import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ChartDataTableBody, type ChartTableColumn } from "@/components/chart/ChartDataTable";
import { DEFAULT_FORMATTERS } from "./format";
import type { FlowAvailability } from "./net";
import { tableDescription } from "./columnCopy";
import { tierDisplayLabel } from "./geometry";
import {
  telFlowRows, tierSummaryRows, walletsFlowRows,
  type RailField,
} from "./railSummary";

const MAX_ROWS = 200;
const R = "right" as const;

const WALLETS_SUMMARY: ChartTableColumn[] = [
  { key: "tier", label: "Tier" },
  { key: "wallets", label: "Wallets", align: R },
  { key: "net", label: "Net wallets", align: R },
  { key: "arrived", label: "Arrived", align: R },
  { key: "left", label: "Left", align: R },
];

const telSummary = (ticker: string): ChartTableColumn[] => [
  { key: "tier", label: "Tier" },
  { key: "held", label: `${ticker} held`, align: R },
  { key: "net", label: `Net ${ticker}`, align: R },
  { key: "buy", label: "Buy (DEX + exchange out)", align: R },
  { key: "sell", label: "Sell (DEX + exchange in)", align: R },
  { key: "redistIn", label: "Redistribution in", align: R },
  { key: "redistOut", label: "Redistribution out", align: R },
];

const WALLETS_FLOWS: ChartTableColumn[] = [
  { key: "from", label: "From tier" },
  { key: "to", label: "To tier" },
  { key: "wallets", label: "Wallets", align: R },
];

const TEL_FLOWS: ChartTableColumn[] = [
  { key: "tier", label: "Tier" },
  { key: "endpoint", label: "Source / destination" },
  { key: "direction", label: "Direction" },
  { key: "cls", label: "Class" },
  { key: "amount", label: "Amount", align: R },
];

type Props = {
  fields: readonly RailField[];
  metric: "wallets" | "tel";
  ticker: string;
  rangeLabel: string;
  /** Formatted "as of" date, or null when the feed has none. */
  asOfDate: string | null;
  /** Window phrase (columnCopy.periodPhrase), e.g. "from Jan 1 to Oct 30". */
  period: string;
  avail?: FlowAvailability;
};
/** Text alternative for the Tier flows diagram: summary and flow tables in a right-hand sheet. */
export const TierFlowTableSheet = ({ fields, metric, ticker, rangeLabel, asOfDate, period, avail }: Props) => {
  const wallets = metric === "wallets";
  const label = (tier: unknown) => tierDisplayLabel(String(tier));
  const summary = tierSummaryRows(fields, metric, DEFAULT_FORMATTERS, avail).map((r) => ({ ...r, tier: label(r.tier) }));
  const flows = wallets
    ? walletsFlowRows(fields).map((r) => ({ ...r, from: label(r.from), to: label(r.to) }))
    : telFlowRows(fields).map((r) => ({ ...r, tier: label(r.tier), amount: DEFAULT_FORMATTERS.fmtTel(r.amount) }));
  const description = tableDescription(asOfDate, period);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="tier-flow-table-button"
          className="inline-flex min-h-11 cursor-pointer items-center self-start rounded-sm text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
        >
          View as table
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-2xl"
        // Portaled, but React events still bubble to the diagram: only Escape (closing the sheet) may pass.
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <SheetHeader className="text-left">
          <SheetTitle>{`Tier flows, ${rangeLabel}`}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-6">
          <section>
            <h3 className="mb-1 text-sm font-semibold">Tier summary</h3>
            <ChartDataTableBody
              caption={`Tier summary, ${rangeLabel}`}
              columns={wallets ? WALLETS_SUMMARY : telSummary(ticker)}
              rows={summary}
              maxRows={MAX_ROWS}
              newestFirst={false}
            />
          </section>
          <section>
            <h3 className="mb-1 text-sm font-semibold">Flows</h3>
            {wallets && (
              <p className="mb-1 text-xs text-muted-foreground">
                Wallet moves between tiers are counted across all chains combined.
              </p>
            )}
            <ChartDataTableBody
              caption={`Tier flows, ${rangeLabel}`}
              columns={wallets ? WALLETS_FLOWS : TEL_FLOWS}
              rows={flows}
              maxRows={MAX_ROWS}
              newestFirst={false}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
};
