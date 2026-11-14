/**
 * Shared, presentation-only formatting helpers. One place for "1.23B" style
 * numbers, human data ages ("21 days ago" rather than "509h ago") and the
 * freshness verdict the page header and stale banner both read from, so the
 * two can never disagree about how old the data is.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** How a value below the lowest tier (< 1K, or where K is disabled) is printed. */
export type CompactBase =
  /** en-US grouped, no fraction digits (the default). */
  | "grouped"
  /** Reader's locale, Math.round first: "1,235". */
  | "locale-rounded"
  /** Math.round with no grouping: "1235". */
  | "plain-rounded"
  /** Reader's locale, up to 2 fraction digits: "12.35". */
  | "locale-2dp";

export type CompactOptions = {
  /** Fraction digits for the T and B tiers (default 2). */
  digits?: number;
  /** Fraction digits for M (default: `digits`). */
  millionDigits?: number;
  /** Fraction digits for K (default: min(digits, 1)); null disables the K tier. */
  thousandDigits?: number | null;
  /**
   * "magnitude" (default) picks the tier from |value|; "value" compares the signed
   * value, so a negative falls to the base branch (a few legacy call sites).
   */
  tierBy?: "magnitude" | "value";
  /** Drop trailing zeros: 1.50B -> 1.5B, 100.00B -> 100B. */
  trim?: boolean;
  base?: CompactBase;
  /** Text for null / undefined / non-finite input (default "—"). */
  nonFinite?: string;
  /** Promote to the next tier when the lower tier would round up to 1000 (999,500 -> "1.0M", not "1000K"). Never promotes into T. */
  promoteRounded?: boolean;
};

const TIERS = [
  { div: 1e12, suffix: "T" },
  { div: 1e9, suffix: "B" },
  { div: 1e6, suffix: "M" },
  { div: 1e3, suffix: "K" },
] as const;

const MAX_SMALL_DIGITS = 12;

/** 0 < |v| < 1: two significant digits (0.0042, 0.5), trailing zeros dropped. */
const formatSmall = (value: number): string => {
  const places = Math.min(MAX_SMALL_DIGITS, Math.ceil(-Math.log10(Math.abs(value))) + 1);
  // toFixed + regex, not Number(): String(4.2e-7) is exponent notation.
  const out = value.toFixed(places).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return out === "-0" ? "0" : out;
};

const formatBase = (value: number, base: CompactBase): string => {
  switch (base) {
    case "locale-rounded":
      return new Intl.NumberFormat().format(Math.round(value));
    case "plain-rounded":
      return `${Math.round(value)}`;
    case "locale-2dp":
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
    default:
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  }
};

/**
 * Compact token / count formatting: 1.23T, 1.23B, 456.7M, 12.3K, 999, 0.0042.
 * A bare number is the fraction-digit shorthand (`formatCompact(v, 0)`); pass
 * `CompactOptions` for the per-surface shapes in the COMPACT_* presets below.
 */
export const formatCompact = (value: number | null | undefined, opts: number | CompactOptions = 2): string => {
  const o: CompactOptions = typeof opts === "number" ? { digits: opts } : opts;
  if (value == null || !Number.isFinite(value)) return o.nonFinite ?? "—";
  const digits = o.digits ?? 2;
  const abs = Math.abs(value);
  if (abs > 0 && abs < 1) return formatSmall(value);
  const tierValue = o.tierBy === "value" ? value : abs;
  const tierDigits = (suffix: string): number | null =>
    suffix === "K" ? (o.thousandDigits === undefined ? Math.min(digits, 1) : o.thousandDigits) : suffix === "M" ? (o.millionDigits ?? digits) : digits;
  const fix = (n: number, d: number) => (o.trim ? `${+n.toFixed(d)}` : n.toFixed(d));
  for (let i = 0; i < TIERS.length; i++) {
    const { div, suffix } = TIERS[i];
    const d = tierDigits(suffix);
    if (d === null) continue;
    const next = TIERS[i + 1];
    const nextDigits = next ? tierDigits(next.suffix) : null;
    const promoted =
      o.promoteRounded && div !== 1e12 && next && nextDigits !== null && Number((tierValue / next.div).toFixed(nextDigits)) >= 1000;
    if (tierValue >= div || promoted) return `${fix(value / div, d)}${suffix}`;
  }
  return formatBase(value, o.base ?? "grouped");
};

// Per-surface shapes. The call sites below printed these before the formatters were
// merged; they are kept explicit so the merge changed no visible output in [1, 1e12).
// The disagreements (K or no K, 1 vs 2 digits) are an owner decision, not this file's.
const LEGACY_NAN = "NaN";
/** SupplyBreakdown, TelDispositionLedger, DispositionPnlView, LockedAnalysisTile (which overrides nonFinite). */
export const COMPACT_LEDGER: CompactOptions = { tierBy: "value", digits: 2, thousandDigits: 1, base: "locale-rounded", nonFinite: LEGACY_NAN };
/** DexSwaps, ExchangeNetflow. */
export const COMPACT_FLOW_ROW: CompactOptions = { digits: 2, millionDigits: 1, thousandDigits: 0, base: "plain-rounded", nonFinite: LEGACY_NAN };
/** CexHistoryTiles. */
export const COMPACT_CEX_TILE: CompactOptions = { ...COMPACT_FLOW_ROW, tierBy: "value" };
/** WalletFlowsPanel. */
export const COMPACT_WALLET_FLOWS: CompactOptions = { digits: 2, millionDigits: 1, thousandDigits: 1, base: "locale-rounded", nonFinite: LEGACY_NAN };
/** Distribution / holdings widgets and the ecosystem headline tiles. */
export const COMPACT_TOKEN_AMOUNT: CompactOptions = { digits: 2, thousandDigits: 2, base: "locale-2dp", nonFinite: LEGACY_NAN };
/** Ledger claim sentences. */
export const COMPACT_CLAIM: CompactOptions = { digits: 1, thousandDigits: 1, base: "plain-rounded", nonFinite: LEGACY_NAN };
/** Chart axes / tooltips that print "<n>B <unit>" (no K tier); callers set the digits. */
export const COMPACT_AXIS: CompactOptions = { thousandDigits: null, base: "locale-rounded", nonFinite: LEGACY_NAN };
/** supplyTargetLabel (>= 1M only): "100B", "1.5B"; no K tier, trailing zeros dropped. */
export const COMPACT_TARGET_LABEL: CompactOptions = { digits: 2, thousandDigits: null, trim: true };
/** Tier-flow rails: rounds up into the next tier instead of "1000K". */
export const COMPACT_TIERFLOW: CompactOptions = { digits: 2, millionDigits: 1, thousandDigits: 0, base: "plain-rounded", promoteRounded: true };

/** True when a formatted magnitude reads as zero ("0", "0.0", "0.00%", "0K"). */
export const isZeroText = (s: string): boolean => !/[1-9]/.test(s);

export const formatSignedCompact = (value: number, digits = 2): string => {
  const mag = formatCompact(Math.abs(value), digits);
  return value === 0 || isZeroText(mag) ? mag : `${value > 0 ? "+" : "−"}${mag}`;
};

/** "just now", "12 min ago", "5 hours ago", "1 day ago", "21 days ago". */
export const formatRelativeAge = (iso: string | null | undefined, now: number = Date.now()): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = Math.max(0, now - t);
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min ago`;
  if (diff < DAY_MS) {
    const h = Math.floor(diff / HOUR_MS);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diff / DAY_MS);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

/** "Oct 2, 2026" in the reader's locale. */
export const formatShortDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export type Freshness = {
  /** fresh: within the daily cadence; delayed: a missed run or two; stale: a week+. */
  status: "fresh" | "delayed" | "stale" | "unknown";
  ageDays: number | null;
  relative: string | null;
  date: string | null;
  /** "Oct 2" — compact form for tight UI; `date` keeps the year. */
  monthDay: string | null;
};

/** The feeds refresh daily; allow a few hours of slack before calling it late. */
export const FRESH_WINDOW_HOURS = 36;
export const STALE_AFTER_DAYS = 7;

export const describeFreshness = (iso: string | null | undefined, now: number = Date.now()): Freshness => {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return { status: "unknown", ageDays: null, relative: null, date: null, monthDay: null };
  const diff = Math.max(0, now - t);
  const ageDays = Math.floor(diff / DAY_MS);
  const status = diff <= FRESH_WINDOW_HOURS * HOUR_MS ? "fresh" : ageDays >= STALE_AFTER_DAYS ? "stale" : "delayed";
  return {
    status,
    ageDays,
    relative: formatRelativeAge(iso, now),
    date: formatShortDate(iso),
    monthDay: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  };
};

const SOURCE_LABELS: Record<string, string> = {
  rpc: "On-chain RPC",
  etherscan: "Etherscan",
  alchemy: "Alchemy",
  dune: "Dune",
  explorer: "Block explorer",
};

/**
 * Human label for a snapshot's data source. The raw provider and upstream are
 * often the same token ("rpc" / "rpc"), which rendered as "Rpc • rpc".
 */
export const formatSourceLabel = (parts: Array<string | null | undefined>): string | null => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    if (!raw) continue;
    const key = raw.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(
      SOURCE_LABELS[key] ??
        (raw.includes(".") || raw.includes(" ")
          ? raw.trim()
          : raw
          .split(/[_\s]+/)
          .filter(Boolean)
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(" ")),
    );
  }
  return out.length ? out.join(" · ") : null;
};

/** "+3" / "−2" / "0" — never "-0". */
export const signedInt = (v: number): string => {
  const r = Math.round(v);
  if (r === 0) return "0";
  return r > 0 ? `+${new Intl.NumberFormat("en-US").format(r)}` : `−${new Intl.NumberFormat("en-US").format(-r)}`;
};
