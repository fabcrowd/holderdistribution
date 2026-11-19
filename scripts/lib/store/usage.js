// Usage of design 8.1: provider use counted per run, per day and per month, carried in the
// bundle and mirrored in the manifest entry, so the monthly guard reads manifests and no
// cross-coin usage file.
//
// Known limit (review M2, accepted): a run's use is added only when its bundle becomes a
// manifest entry. The use of a failed attempt, a stale candidate or a refused candidate is
// never added, because the next attempt takes the main entry's usage as its parent. The
// monthly guard therefore undercounts by that amount; the provider's own meter stays the
// source of truth.
//
// Cost: one small map of provider names; it does not grow with N,
// H, C or D.
import { shapeOf, isDay } from "./shape.js";

const KEYS = ["day", "month", "run", "dayTotal", "monthTotal"];
export const monthOf = (day) => day.slice(0, 7);

function counts(s, v, at) {
  s.map(v, at, (n, where) => s.uint(n, where));
}

export function validateUsage(v, label, at = "usage") {
  const s = shapeOf(label);
  s.object(v, at, KEYS);
  s.day(v.day, `${at}.day`);
  if (v.month !== monthOf(v.day)) throw s.bad(`${at}.month`, `must be ${monthOf(v.day)} (the month of ${v.day}), got ${JSON.stringify(v.month)}`);
  for (const k of ["run", "dayTotal", "monthTotal"]) counts(s, v[k], `${at}.${k}`);
  return v;
}

// Built in a Map and turned into an object by fromEntries, so no key is ever assigned as a
// property of a plain object (a "__proto__" key would be lost that way).
const add = (a, b) => {
  const sums = new Map(Object.entries(a));
  for (const [k, n] of Object.entries(b)) sums.set(k, (sums.get(k) ?? 0) + n);
  return Object.fromEntries(sums);
};

// `day` is the day the use is accounted to; `parent` is the parent entry's usage or null.
// Each run's use is added once: the parent's totals already hold the parent's own run.
export function nextUsage({ parent, day, used }) {
  const s = shapeOf("usage");
  if (!isDay(day)) throw s.bad("day", `must be a calendar day (YYYY-MM-DD), got ${JSON.stringify(day)}`);
  counts(s, used, "used");
  if (parent) validateUsage(parent, "usage", "parent");
  const month = monthOf(day);
  return {
    day,
    month,
    run: { ...used },
    dayTotal: add(parent?.day === day ? parent.dayTotal : {}, used),
    monthTotal: add(parent?.month === month ? parent.monthTotal : {}, used),
  };
}
