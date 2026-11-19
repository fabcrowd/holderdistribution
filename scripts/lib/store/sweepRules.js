// The rules of design 2.1 section 4.3 for one stored object, as pure functions. `decide`
// answers keep, delete, or "needs the header of the pack first": the coins a pack lists
// come from its header, which the caller reads only for objects that already pass every
// rule that needs no header (sweepPlan.js headerCandidates).
//
// Two clocks, by rule:
//   - elapsed time (`now` minus `createdAt`, in milliseconds) for the two waits counted from
//     creation: the `live` wait (SWEEP_WAIT_DAYS x 24 h) and the dead-upload wait
//     (DEAD_UPLOAD_WAIT_DAYS x 24 h). A calendar-day count would let a wait end minutes after
//     the asset was made, in the middle of an upload that began before midnight;
//   - calendar days (`today` against the day written in the pack's name, or against the night a
//     coin was first missing) for `hist`, `events` and the removed-coin hold, because the design
//     states those as days of the data, not as hours since an upload.
// An object whose `createdAt` is missing or does not parse is kept and reported where a wait
// from creation applies.
import { isDay } from "./shape.js";
import { parseStoreName } from "./packNames.js";
import {
  SWEEP_WAIT_DAYS, EVENTS_KEEP_DAYS, REMOVED_COIN_HOLD_DAYS, DEAD_UPLOAD_WAIT_DAYS, SITE_ROOTS_KEPT,
} from "./storeConstants.js";
import { SweepPlanError } from "./sweepErrors.js";

export const DAY_MS = 86_400_000;
export const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
export const ageInDays = (today, day) => dayNumber(today) - dayNumber(day);
export const dayBefore = (today, n) => new Date((dayNumber(today) - n) * DAY_MS).toISOString().slice(0, 10);

// Milliseconds since creation, or null when createdAt is missing or does not parse.
export function elapsedSince(o, nowMs) {
  const t = typeof o.createdAt === "string" ? Date.parse(o.createdAt) : Number.NaN;
  return Number.isNaN(t) ? null : nowMs - t;
}

const keep = (code, reason, waiting = false) => ({ outcome: "keep", code, reason, waiting });
const del = (rule) => ({ outcome: "delete", rule });

// Unreferenced bytes of a kept object count as "waiting" in the summary only when time or
// a pin is what holds them, not when the horizon or a reference legitimately does.
const hours = (ms) => `${(ms / 3_600_000).toFixed(2)} h`;

function createdUnknown(o) {
  return keep("created-unknown", `createdAt ${JSON.stringify(o.createdAt)} of ${o.loc} is missing or not a time, so its wait cannot be measured; kept and reported`, true);
}

function timeRule(o, p, ctx) {
  const dead = o.state !== "uploaded";
  const elapsed = elapsedSince(o, ctx.nowMs);
  if ((dead || o.series === "live" || o.series === "site") && elapsed === null) return createdUnknown(o);
  if (dead) {
    return elapsed < DEAD_UPLOAD_WAIT_DAYS * DAY_MS
      ? keep("dead-upload-young", `dead upload (state ${o.state}), ${hours(elapsed)} old, goes at ${DEAD_UPLOAD_WAIT_DAYS * 24} h`, true)
      : del(`dead upload (state ${o.state}) ${hours(elapsed)} old, at least ${DEAD_UPLOAD_WAIT_DAYS * 24} h; named by no readable coin`);
  }
  if (o.series === "hist") {
    return p.day >= ctx.horizonFirst
      ? keep("inside-horizon", `newest day ${p.day} is inside the horizon (from ${ctx.horizonFirst})`)
      : del(`newest day ${p.day} is outside the horizon (before ${ctx.horizonFirst})`);
  }
  if (o.series === "events") {
    const days = ageInDays(ctx.today, p.day);
    return days <= EVENTS_KEEP_DAYS
      ? keep("events-recent", `day ${p.day} is ${days} day(s) old, kept ${EVENTS_KEEP_DAYS}`)
      : del(`day ${p.day} is ${days} days old, more than ${EVENTS_KEEP_DAYS}`);
  }
  return elapsed < SWEEP_WAIT_DAYS * DAY_MS
    ? keep("too-young", `named by no readable coin, ${hours(elapsed)} old, waits until ${SWEEP_WAIT_DAYS * 24} h`, true)
    : del(`named by no readable coin; ${hours(elapsed)} old (${(elapsed / DAY_MS).toFixed(2)} days), at least ${SWEEP_WAIT_DAYS} days`);
}

function removedHold(slug, ctx) {
  const days = ageInDays(ctx.today, ctx.removed.get(slug));
  return days < REMOVED_COIN_HOLD_DAYS
    ? keep("removed-coin-hold", `lists removed coin ${slug}, first missing ${days} day(s) ago, held ${REMOVED_COIN_HOLD_DAYS}`, true)
    : null;
}

// What a pack's coins say about it, strictest first: an unreadable coin pins it (4.3, 10(j)),
// a coin nobody classified pins it, a removed coin holds it, and for `hist` a readable coin
// that still needs a change file of that day pins it.
function coinsRule(o, p, ctx, coins, rule) {
  // null or { failure: "unreadable" }: the header could not be read; { failure: "no-coin-list" }: it was read and lists no coins.
  if (coins?.failure === "no-coin-list") return keep("no-coin-list", `header of ${o.loc} has no list of coins, so its coins are unknown; kept and reported`, true);
  if (coins === null || !Array.isArray(coins)) return keep("header-unreadable", `header of ${o.loc} cannot be read, so its coins are unknown; kept and reported`, true);
  const bad = coins.find((s) => ctx.unreadable.has(s));
  if (bad) return keep("unreadable-coin", `lists ${bad}, unreadable tonight`, true);
  const unknown = coins.find((s) => !ctx.readable.has(s) && !ctx.removed.has(s));
  if (unknown) return keep("unknown-coin", `lists ${unknown}, which is neither readable, unreadable nor removed; kept and reported`, true);
  for (const s of coins) {
    const held = ctx.removed.has(s) && removedHold(s, ctx);
    if (held) return held;
  }
  if (o.series === "hist") {
    for (const s of coins.filter((c) => ctx.readable.has(c))) {
      const need = ctx.oldestNeeded.get(s);
      if (!isDay(need)) return keep("needed-day-unknown", `${s} has no oldest needed change day, so ${p.day} cannot be released`, true);
      if (need <= p.day) return keep("needed-by-coin", `${s} still needs change files from ${need}, on or before ${p.day}`, true);
    }
  }
  return del(`${rule}; no listed coin is unreadable${o.series === "hist" ? " or still needs this day" : ""}`);
}

export function decide(o, ctx, coins) {
  const p = parseStoreName(o.name);
  if (!p) return keep("not-a-store-name", `${o.name} is not a store name; never touched, reported`);
  if (p.series !== o.series) return keep("wrong-series", `${o.name} is a ${p.series} name inside the ${o.series} series; never touched, reported`);
  const named = ctx.namedBy.get(o.loc);
  if (named) return keep("referenced", `named by ${named.join(", ")}`);
  const prot = ctx.siteProtected.get(o.loc);
  if (prot !== undefined) return keep("site-root-protected", `site root number ${prot} of the current root and the ${SITE_ROOTS_KEPT} before it`, true);
  const t = timeRule(o, p, ctx);
  if (t.outcome === "keep" || o.state !== "uploaded" || o.series === "site") return t;
  return coins === undefined ? { outcome: "needsHeader", rule: t.rule } : coinsRule(o, p, ctx, coins, t.rule);
}
