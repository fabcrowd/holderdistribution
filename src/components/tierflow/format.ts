import { COMPACT_TIERFLOW, formatCompact } from "@/lib/format";

/** Signed figure. A value that rounds to zero at display precision is a plain neutral "0", never "+0". */
export const signed = (v: number, f: (n: number) => string) => {
  const body = f(Math.abs(v));
  if (!/[1-9]/.test(body)) return body;
  return `${v < 0 ? "−" : "+"}${body}`;
};

const UNKNOWN = "—";

// promoteRounded: compare the rounded value so 999,500 reads 1.0M rather than 1000K.
export const fmtTel = (v: number) => formatCompact(v, { ...COMPACT_TIERFLOW, nonFinite: UNKNOWN });

export const fmtInt = (v: number) => (Number.isFinite(v) ? new Intl.NumberFormat().format(Math.round(v)) : UNKNOWN);

export type Formatters = {
  signed: typeof signed;
  fmtInt: typeof fmtInt;
  fmtTel: typeof fmtTel;
};

export const DEFAULT_FORMATTERS: Formatters = { signed, fmtInt, fmtTel };
