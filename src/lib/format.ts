/**
 * Shared, presentation-only formatting helpers. One place for "1.23B" style
 * numbers, human data ages ("21 days ago" rather than "509h ago") and the
 * freshness verdict the page header and stale banner both read from, so the
 * two can never disagree about how old the data is.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Compact token / count formatting: 1.23B, 456.7M, 12.3K, 999. */
export const formatCompact = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(Math.min(digits, 1))}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
};

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
