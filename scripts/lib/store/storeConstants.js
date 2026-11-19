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
