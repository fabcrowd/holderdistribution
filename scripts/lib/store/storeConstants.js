// Windows of design 2.1 section 1 ("Adoption window"), in one place. The adoption window
// is how many days of a coin's bundles stay restorable; the sweep waits two days longer
// before it deletes anything (margin for a failed night).
export const ADOPTION_WINDOW_DAYS = 16;
export const SWEEP_WAIT_DAYS = 18;
