export type PeriodGroup = "summary" | "quarter" | "month";

export type DispositionPeriod = {
  id: string;
  label: string;
  group: PeriodGroup;
  start: string;
  end: string;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

export const utcDay = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}-${pad2(m)}-${pad2(d)}`;
};

const utcYmd = (year: number, monthIndex: number, day: number): string => {
  const ms = Date.UTC(year, monthIndex, day);
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
};

const lastDayOfMonth = (year: number, monthIndex: number): string => utcYmd(year, monthIndex + 1, 0);

const parseUtcDay = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
};

const endExclusive = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d + 1) / 1000;
};

const clampIso = (iso: string, min: string, max: string): string => {
  if (iso < min) return min;
  if (iso > max) return max;
  return iso;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const iterateMonths = (start: string, end: string): Array<{ year: number; month: number }> => {
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  const out: Array<{ year: number; month: number }> = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};

export const buildDispositionPeriods = (
  window: { start: string; end: string },
  now: Date = new Date(),
): DispositionPeriod[] => {
  const windowStart = utcDay(window.start);
  const windowEnd = utcDay(window.end);
  const today = utcYmd(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rangeEnd = today < windowEnd ? today : windowEnd;

  const all: DispositionPeriod = {
    id: "all",
    label: "All recorded",
    group: "summary",
    start: windowStart,
    end: windowEnd,
  };

  const ytdStart = utcYmd(now.getUTCFullYear(), 0, 1);
  const ytd: DispositionPeriod | null =
    ytdStart <= rangeEnd && windowEnd >= ytdStart
      ? {
          id: "ytd",
          label: "Year to date",
          group: "summary",
          start: clampIso(ytdStart, windowStart, rangeEnd),
          end: clampIso(rangeEnd, windowStart, rangeEnd),
        }
      : null;

  const quarters: DispositionPeriod[] = [];
  const startYear = Number(windowStart.slice(0, 4));
  const endYear = Number(rangeEnd.slice(0, 4));
  for (let year = startYear; year <= endYear; year++) {
    for (let q = 1; q <= 4; q++) {
      const qStart = utcYmd(year, (q - 1) * 3, 1);
      const qEndRaw = lastDayOfMonth(year, q * 3 - 1);
      if (qEndRaw < windowStart || qStart > rangeEnd) continue;
      quarters.push({
        id: `${year}-Q${q}`,
        label: `Q${q} ${year}`,
        group: "quarter",
        start: clampIso(qStart, windowStart, rangeEnd),
        end: clampIso(qEndRaw, windowStart, rangeEnd),
      });
    }
  }

  const months: DispositionPeriod[] = iterateMonths(windowStart, rangeEnd).map(({ year, month }) => {
    const mStart = utcYmd(year, month - 1, 1);
    const mEnd = lastDayOfMonth(year, month - 1);
    return {
      id: `${year}-${pad2(month)}`,
      label: `${MONTH_LABELS[month - 1]} ${year}`,
      group: "month",
      start: clampIso(mStart, windowStart, rangeEnd),
      end: clampIso(mEnd, windowStart, rangeEnd),
    };
  });

  return [all, ...(ytd ? [ytd] : []), ...quarters, ...months];
};

export const inPeriod = (timestamp: number | null, period: DispositionPeriod): boolean => {
  if (timestamp == null) return period.id === "all";
  return timestamp >= parseUtcDay(period.start) && timestamp < endExclusive(period.end);
};

export const filterByPeriod = <T extends { timestamp: number | null }>(
  items: T[],
  period: DispositionPeriod,
): T[] => items.filter((item) => inPeriod(item.timestamp, period));
