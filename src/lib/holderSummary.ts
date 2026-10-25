import { formatCompact } from "@/lib/format";

/**
 * Plain-language "what is happening with <ticker> holders" summary for the page
 * intro. Built only from the same four headline numbers the KPI tiles show, so
 * the sentence and the tiles can never disagree. A metric whose comparison is
 * blocked by a classification change (see ChangeIndicator) contributes its
 * level but never a direction: a relabel is not a trend.
 */
export type SummaryMetric = {
  current: number | null;
  previous: number | null;
  /** True when a reclassification happened inside the comparison window. */
  comparisonBlocked?: boolean;
};

export type SummaryInput = {
  holders: SummaryMetric;
  retailHeld: SummaryMetric;
  staked: SummaryMetric;
  cex: SummaryMetric;
  totalSupply: number;
  /** "YTD", "30D", … — the page's selected range. */
  rangeLabel: string;
  /** Active project's ticker, e.g. "TEL" (config/projects/<slug>.json). */
  ticker: string;
};

export type SummaryPoint = {
  id: "holders" | "retailHeld" | "staked" | "cex";
  text: string;
  /** up/down for colour + icon; flat or unknown renders neutral. */
  trend: "up" | "down" | "flat" | "unknown";
};

export type HolderSummary = {
  headline: string;
  points: SummaryPoint[];
};

const int = new Intl.NumberFormat("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const pctLabel = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;

const change = (m: SummaryMetric): { diff: number; rel: number | null } | null => {
  if (m.comparisonBlocked || m.current === null || m.previous === null) return null;
  const diff = m.current - m.previous;
  return { diff, rel: m.previous !== 0 ? (diff / m.previous) * 100 : null };
};

const rangePhrase = (label: string) => (label === "YTD" ? "this year" : `over ${label}`);

export const buildHolderSummary = (input: SummaryInput): HolderSummary | null => {
  const { holders, retailHeld, staked, cex, totalSupply, rangeLabel, ticker } = input;
  if (holders.current === null || retailHeld.current === null) return null;

  const retailShare = pct(retailHeld.current, totalSupply);
  const headline = `${int.format(holders.current)} retail wallets hold ${formatCompact(retailHeld.current)} ${ticker} — ${pctLabel(retailShare)} of the ${formatCompact(totalSupply, 0)} supply.`;

  const points: SummaryPoint[] = [];
  const when = rangePhrase(rangeLabel);

  const h = change(holders);
  if (h) {
    const rel = h.rel !== null ? ` (${h.rel > 0 ? "+" : h.rel < 0 ? "−" : ""}${Math.abs(h.rel).toFixed(1)}%)` : "";
    points.push(
      h.diff === 0
        ? { id: "holders", text: `Retail holder count unchanged ${when}`, trend: "flat" }
        : {
            id: "holders",
            text: `Retail holders ${h.diff > 0 ? "up" : "down"} ${int.format(Math.abs(h.diff))}${rel} ${when}`,
            trend: h.diff > 0 ? "up" : "down",
          },
    );
  } else if (holders.comparisonBlocked) {
    points.push({ id: "holders", text: `Holder change ${when} not directly comparable (some wallets were reclassified)`, trend: "unknown" });
  }

  const s = change(staked);
  if (staked.current !== null) {
    points.push(
      s && s.diff !== 0
        ? {
            id: "staked",
            text: `Staked ${ticker} ${s.diff > 0 ? "up" : "down"} ${formatCompact(Math.abs(s.diff))} ${when}, now ${formatCompact(staked.current)}`,
            trend: s.diff > 0 ? "up" : "down",
          }
        : { id: "staked", text: `${formatCompact(staked.current)} ${ticker} staked`, trend: s ? "flat" : "unknown" },
    );
  }

  if (cex.current !== null) {
    const c = change(cex);
    const dir = c && c.diff !== 0 ? `, ${c.diff > 0 ? "up" : "down"} ${formatCompact(Math.abs(c.diff))} ${when}` : "";
    points.push({
      id: "cex",
      text: `${formatCompact(cex.current)} ${ticker} (${pctLabel(pct(cex.current, totalSupply))}) sits on exchanges${dir}`,
      // Exchange balances are neither good nor bad on their own.
      trend: "flat",
    });
  }

  return { headline, points };
};
