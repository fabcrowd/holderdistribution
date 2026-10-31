/** Signed figure. A value that rounds to zero at display precision is a plain neutral "0", never "+0". */
export const signed = (v: number, f: (n: number) => string) => {
  const body = f(Math.abs(v));
  if (!/[1-9]/.test(body)) return body;
  return `${v < 0 ? "−" : "+"}${body}`;
};

export const fmtTel = (v: number) => {
  const a = Math.abs(v);
  // Compare the rounded value so 999,500 reads 1.0M rather than 1000K.
  if (a >= 1e9 || Number((a / 1e6).toFixed(1)) >= 1000) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6 || Math.round(a / 1e3) >= 1000) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${Math.round(v)}`;
};

export const fmtInt = (v: number) => new Intl.NumberFormat().format(Math.round(v));

export type Formatters = {
  signed: typeof signed;
  fmtInt: typeof fmtInt;
  fmtTel: typeof fmtTel;
};

export const DEFAULT_FORMATTERS: Formatters = { signed, fmtInt, fmtTel };
