// Windows of design 2.1 section 1 ("Adoption window"), in one place. The adoption window
// is how many days of a coin's bundles stay restorable; the sweep waits two days longer
// before it deletes anything (margin for a failed night).
export const ADOPTION_WINDOW_DAYS = 16;
export const SWEEP_WAIT_DAYS = 18;

// How long a listed pack that cannot be read may stay "transient" (adoption). A pack younger than
// this, by elapsed time from its creation time to the lane's clock, that answers with a failure to
// obtain its bytes is retried tomorrow; an older one is a bad object and is dropped with an alert.
// The cost is stated in adoption.js: after this many nights the bundles in such a pack are given
// up, the same consequence as the 15-bundle cap.
export const UNREADABLE_PACK_DAYS = 3;
// Before a pack at or past that bound is given up, the read that failed is tried once more after
// this wait, the same night (adoptionUnreadable.js): one failed read must not drop its bundles.
export const SECOND_LOOK_WAIT_MS = 30_000;
// A second look at a pack shares the wait of an earlier second look at the same pack only when that
// wait ended less than this long ago; a later fault gets a wait of its own.
export const SECOND_LOOK_SHARE_MS = 5_000;
// Windows and limits of the nightly sweep (design 2.1 section 4.3), named here so the plan
// and its tests share them.
export const EVENTS_KEEP_DAYS = 4; // an `events` pack goes when its day is more than this old
export const REMOVED_COIN_HOLD_DAYS = 30; // packs listing a removed coin wait this long after the night it was first missing
export const DEAD_UPLOAD_WAIT_DAYS = 1; // an asset not in state `uploaded` goes after this many days
export const SITE_ROOTS_KEPT = 16; // the current site root is kept, and this many older ones
export const MIN_HISTORY_DAYS = 371; // design section 1: historyDays is never below this
export const SWEEP_DELETE_GAP_MS = 1000; // deletes are paced one second apart
// A release backend learns the newest release of a series at most this long before it uploads into it
// (blobStoreRelease.js target): a process of any age re-learns it, so the sweep's wait on a release's
// successor (DEAD_UPLOAD_WAIT_DAYS) leaves a margin of the wait minus this minus one upload.
// Release numbers whose git tag survives a deleted release: one upload skips at most this many in a row
// before it throws (blobStoreRelease.js target); one per creation costs a request.
export const MAX_USED_NUMBER_SKIPS = 8;
export const NEWEST_RELEASE_MAX_AGE_MS = 3_600_000;
export const SWEEP_CAP_FACTOR = 2; // deletes per run are capped at this many times the packs written
