import { stableQuoteUsd } from "./dispositionPnl";

export type SalesJournalColumn = "date" | "from" | "tel" | "stablecoin" | "payee";
export type SalesJournalDir = "asc" | "desc";

export type SalesJournalRow = {
  timestamp: number | null;
  fromName: string;
  telAmount: number;
  quoteToken: string | null;
  quoteAmount: number | null;
  proceedTo: string | null;
  proceedStatus: string | null;
};

export type SalesJournalSort = {
  column: SalesJournalColumn;
  dir: SalesJournalDir;
};

const TEXT_COLUMNS = new Set<SalesJournalColumn>(["from", "payee"]);

export const defaultSalesJournalDir = (column: SalesJournalColumn): SalesJournalDir =>
  TEXT_COLUMNS.has(column) ? "asc" : "desc";

export const nextSalesJournalSort = (
  current: SalesJournalSort | null,
  clicked: SalesJournalColumn,
): SalesJournalSort => {
  if (current?.column === clicked) {
    return { column: clicked, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { column: clicked, dir: defaultSalesJournalDir(clicked) };
};

const payeeKey = (row: SalesJournalRow): string | null => {
  if (row.proceedStatus === "retained_in_wallet") return "still in selling wallet";
  if (row.proceedTo) return row.proceedTo.toLowerCase();
  return null;
};

const valueOf = (row: SalesJournalRow, column: SalesJournalColumn): number | string | null => {
  switch (column) {
    case "date":
      return row.timestamp;
    case "from":
      return row.fromName.toLowerCase();
    case "tel":
      return row.telAmount;
    case "stablecoin": {
      const usd = stableQuoteUsd(row.quoteToken, row.quoteAmount);
      return usd || null;
    }
    case "payee":
      return payeeKey(row);
  }
};

const cmp = (
  a: number | string | null,
  b: number | string | null,
  dir: SalesJournalDir,
): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const raw =
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? raw : -raw;
};

export const sortSalesJournal = <T extends SalesJournalRow>(
  rows: T[],
  column: SalesJournalColumn,
  dir: SalesJournalDir,
): T[] => [...rows].sort((left, right) => cmp(valueOf(left, column), valueOf(right, column), dir));
