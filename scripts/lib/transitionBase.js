/**
 * Which past snapshot a holder-transitions window may use as its base (generate-holder-transitions.js).
 *
 * The generator finds past snapshots by commit date and then reads each snapshot's own date. A
 * snapshot dated before the project's first holders-history.json row is not a valid base: the
 * project's history was restarted there, because its holder rule changed (HBAR, 2026-11-14: from
 * "at least 1 HBAR" to every positive balance). Such snapshots stay in git, and comparing against
 * one would mix two holder definitions in one matrix. The base steps forward to the first snapshot
 * dated on or after the first history row.
 */

/**
 * @param {object} args
 * @param {number} args.startIndex        index (in commit-date order) the window asked for
 * @param {number} args.count             number of snapshots in git
 * @param {string|null} args.earliest     first holders-history date (YYYY-MM-DD), or null
 * @param {(index: number) => string} args.snapshotDateAt  the snapshot's own date at an index
 * @returns {number} the index to use; the last index when no snapshot is late enough
 */
export const baseSnapshotIndex = ({ startIndex, count, earliest, snapshotDateAt }) => {
  let index = startIndex;
  while (earliest && index < count - 1 && snapshotDateAt(index) < earliest) index += 1;
  return index;
};
