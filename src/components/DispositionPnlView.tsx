import { ExternalLink } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTooltip } from "@/components/InfoTooltip";
import {
  explorerAddress,
  explorerChainForCenter,
  explorerTx,
  type CostCenter,
  type DispositionPnl,
  type GlLine,
  type PnlTx,
} from "@/lib/dispositionPnl";

const formatCompactAmount = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};

const formatUsd = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const AddrLink = ({
  chain,
  address,
  label,
}: {
  chain: string;
  address: string;
  label?: string | null;
}) => (
  <a
    href={explorerAddress(chain, address)}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1 font-mono text-foreground hover:underline"
  >
    {label || shortAddr(address)}
    <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
  </a>
);

const TxLink = ({ chain, hash }: { chain: string; hash: string }) => (
  <a
    href={explorerTx(chain, hash)}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
    aria-label="View on-chain receipt"
  >
    Receipt
    <ExternalLink className="h-3 w-3" />
  </a>
);

const TxRows = ({ txs, counterpartLabel }: { txs: PnlTx[]; counterpartLabel: string }) => (
  <div className="max-h-64 overflow-auto rounded-md border border-border/40">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-[10px]">Date</TableHead>
          <TableHead className="text-[10px]">{counterpartLabel}</TableHead>
          <TableHead className="text-[10px] text-right">TEL</TableHead>
          <TableHead className="text-[10px] text-right">USD</TableHead>
          <TableHead className="w-16" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {txs.map((tx) => (
          <TableRow key={tx.id}>
            <TableCell className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
              {tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleDateString() : "—"}
            </TableCell>
            <TableCell className="max-w-[12rem] truncate text-[10px]">
              {tx.to ? <AddrLink chain={tx.chain} address={tx.to} label={tx.toLabel} /> : "—"}
            </TableCell>
            <TableCell className="text-right text-[10px] tabular-nums">
              {tx.telAmount ? formatCompactAmount(tx.telAmount) : "—"}
            </TableCell>
            <TableCell className="text-right text-[10px] tabular-nums">
              {tx.usd != null ? formatUsd(tx.usd) : "—"}
            </TableCell>
            <TableCell className="p-1">
              <TxLink chain={tx.chain} hash={tx.txHash} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

const GlLineRow = ({ line }: { line: GlLine }) => (
  <Collapsible>
    <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/40">
      <span className="min-w-0 truncate text-[11px]">
        <span className="mr-2 font-mono tabular-nums text-muted-foreground">{line.code}</span>
        {line.name}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums">
        {line.side === "revenue" ? formatUsd(line.usd) : `${formatCompactAmount(line.tel)} TEL`}
        <span className="ml-2 text-muted-foreground">
          {line.txs.length} {line.txs.length === 1 ? "receipt" : "receipts"}
        </span>
      </span>
    </CollapsibleTrigger>
    <CollapsibleContent className="px-1 pb-2 pt-1">
      <TxRows
        txs={line.txs}
        counterpartLabel={line.side === "revenue" ? "Stablecoin went to" : "Sent to"}
      />
    </CollapsibleContent>
  </Collapsible>
);

const CostCenterBody = ({ center }: { center: CostCenter }) => {
  const income = center.lines.filter((l) => l.side === "revenue");
  const movements = center.lines.filter((l) => l.side === "expense");
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-[11px] text-muted-foreground">
        <span>Wallet</span>
        <AddrLink chain={explorerChainForCenter(center)} address={center.address} />
      </div>
      {center.lines.length === 0 ? (
        <p className="px-2 text-[11px] text-muted-foreground">No TEL left this wallet in this period.</p>
      ) : (
        <div className="space-y-2">
          {income.length > 0 && (
            <div>
              <p className="flex items-center gap-1 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Income
                <InfoTooltip text="USDC or USDT received when this wallet sold TEL. That is income from the sale — not an accrual P&L." />
              </p>
              {income.map((line) => (
                <GlLineRow key={line.code} line={line} />
              ))}
            </div>
          )}
          {movements.length > 0 && (
            <div>
              <p className="flex items-center gap-1 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Uses of TEL
                <InfoTooltip text="TEL that left this wallet. Sold for stablecoin is a conversion. Sent to another Association wallet is a transfer between cost centers, not a cost." />
              </p>
              {movements.map((line) => (
                <GlLineRow key={line.code} line={line} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};

const CostCenterSection = ({ center }: { center: CostCenter }) => (
  <AccordionItem value={center.address} className="border-border/40">
    <AccordionTrigger className="py-2.5 text-sm hover:no-underline">
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <span className="min-w-0 truncate font-medium">{center.name}</span>
        <span className="flex shrink-0 gap-3 text-[11px] font-normal tabular-nums text-muted-foreground">
          <span>{formatUsd(center.usdProceeds)} stablecoin</span>
          <span>{formatCompactAmount(center.telOut)} TEL moved</span>
        </span>
      </span>
    </AccordionTrigger>
    <AccordionContent>
      <CostCenterBody center={center} />
    </AccordionContent>
  </AccordionItem>
);

export const DispositionPnlView = ({
  pnl,
  period,
  periodLabel,
}: {
  pnl: DispositionPnl;
  period: { start: string; end: string };
  periodLabel?: string;
}) => {
  const active = pnl.costCenters.filter((c) => c.telOut > 0 || c.usdProceeds > 0);
  const idle = pnl.costCenters.filter((c) => c.telOut === 0 && c.usdProceeds === 0);
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          P&amp;L by cost center
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">
          {periodLabel ? `${periodLabel} · ` : ""}
          {period.start} – {period.end}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <dt className="flex items-center gap-1 text-muted-foreground">
              Income (stablecoin from sales)
              <InfoTooltip text="USDC/USDT received when Association wallets sold TEL in this period." />
            </dt>
            <dd className="font-semibold tabular-nums">{formatUsd(pnl.totalUsdProceeds)}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-muted-foreground">
              TEL moved
              <InfoTooltip text="TEL that left Association wallets — sold for stablecoin or transferred. Transfers between Association wallets are not expenses." />
            </dt>
            <dd className="font-semibold tabular-nums">{formatCompactAmount(pnl.totalTelOut)} TEL</dd>
          </div>
        </dl>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Records TEL and stablecoin when they move, not a GAAP income statement. Each cost center
          is a council wallet. Expand a center, then a GL line, to open the receipts.
        </p>
      </div>
      <Accordion type="multiple" className="rounded-lg border border-border/40 bg-background/40 px-2">
        {active.map((center) => (
          <CostCenterSection key={center.address} center={center} />
        ))}
        {idle.length > 0 && (
          <AccordionItem value="idle-centers" className="border-border/40">
            <AccordionTrigger className="py-2.5 text-sm hover:no-underline">
              <span className="text-muted-foreground">
                No activity this period ({idle.length})
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-1 px-2 pb-1 text-[11px] text-muted-foreground">
                {idle.map((center) => (
                  <li key={center.address}>{center.name}</li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  );
};
