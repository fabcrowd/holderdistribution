// Errors of the nightly sweep (design 2.1 section 4.3). A thrown SweepError means nothing
// further was deleted; the message names the location or coin and the rule that failed.
export class SweepError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

// The inputs are inconsistent or incomplete, so no plan can be built and nothing is deleted.
export class SweepPlanError extends SweepError {}

// The caller passed `now` or `today` to runSweep, which takes a `clock` instead.
export class SweepClockArgError extends SweepError {}

// A delete failed in a way the sweep does not treat as "stop and report" (that is a 403 or
// 429). `result` holds what was done before it, so the caller can log it.
export class SweepDeleteError extends SweepError {
  constructor(message, result, options) {
    super(message, options);
    this.result = result;
  }
}
