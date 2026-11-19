// Which listed packs a coin's adoption looks at (design 2.1 section 9.3), by name and state
// only, before any read: a `live` pack of the run's kind, in state `uploaded`, dated after the
// main entry's day (a new coin has no main entry and no day bound). The rest is counted by
// reason, so the `why` of an adoption can say what was skipped without one line per pack.
//
// A pack's day is the newest data day of any item in it (its name), the day the design
// compares with the main entry's day: a pack dated on the main entry's day is never adopted.
//
// Cost by size: in memory, linear in the listing (at most the assets of two releases, 1,800);
// no read.
import { packInfo } from "./itemRef.js";
import { parseStoreName } from "./packNames.js";

const plural = (n, one, many) => (n === 1 ? one : many);

export function selectPacks({ entries, kind, main }) {
  const mainDay = main ? main.day : null;
  const skipped = { otherKind: 0, notUploaded: 0, states: new Set(), notNewer: 0 };
  const packs = [];
  for (const entry of entries) {
    const info = packInfo(entry.name);
    if (!info || info.cls !== "live") continue;
    if (info.kind !== kind) skipped.otherKind++;
    else if (entry.state !== "uploaded") {
      skipped.notUploaded++;
      skipped.states.add(entry.state);
    } else if (mainDay !== null && parseStoreName(entry.name).day <= mainDay) skipped.notNewer++;
    else packs.push(entry);
  }
  packs.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  return { packs, skipped };
}

export function skippedLines(skipped, main) {
  const lines = [];
  const { otherKind, notUploaded, notNewer } = skipped;
  if (otherKind > 0) lines.push(`${otherKind} ${plural(otherKind, "pack", "packs")} of another kind ignored`);
  if (notUploaded > 0) lines.push(`${notUploaded} ${plural(notUploaded, "pack", "packs")} not uploaded (state ${[...skipped.states].sort().join(", ")}) ignored`);
  if (notNewer > 0) lines.push(`${notNewer} ${plural(notNewer, "pack", "packs")} dated on or before the main entry's day ${main.day} ignored`);
  return lines;
}

export const doesNotList = (n, slug) => `${n} ${plural(n, "pack does", "packs do")} not list ${slug}`;
export const tooLongLine = (n, cap) => `${n} ${plural(n, "bundle is", "bundles are")} too long: this path never publishes ${plural(n, "it", "them")} (the chain is capped at ${cap} entries so that the run's own entry still fits the publish limit), and recovering ${plural(n, "its day", "their days")} depends on the ledger being readable for past days; this is an outage that needs an operator`;

// The oldest and newest day of the `live` packs of this kind in the listing (any state), or nulls.
export function packDaySpan(entries, kind) {
  const days = entries.filter((e) => packInfo(e.name)?.cls === "live" && packInfo(e.name).kind === kind).map((e) => parseStoreName(e.name).day).sort();
  return { oldestPackDay: days[0] ?? null, newestPackDay: days.at(-1) ?? null };
}

// The bundle items of a pack header that belong to the coin.
export const bundleItemsOf = (header, slug) => header.items.filter((it) => it && it.type === "bundle" && it.slug === slug);
export const listsCoin = (header, slug) => Array.isArray(header.slugs) && header.slugs.includes(slug);
