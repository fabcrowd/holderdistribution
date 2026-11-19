// Errors of the record family (bundle, manifest, candidate, store.json, site.json). One
// base class, so a caller that treats any unreadable record as "unreadable coin" (design
// 9.2 step 3, 10(j)) catches RecordError and never mistakes it for "empty".
export class RecordError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

// The text is not JSON (a merge conflict marker, a truncated file).
export class RecordSyntaxError extends RecordError {}
// Valid JSON, but `schema` is not the one this code reads.
export class RecordSchemaError extends RecordError {}
// A missing field, a field of the wrong type, an unknown field, or a value that breaks a rule.
export class RecordShapeError extends RecordError {}

export class BundleBuildError extends RecordError {}
// The bundle's bytes could not be fetched from the blob store.
export class BundleReadError extends RecordError {}
// The bytes were fetched but are not the bundle the entry names.
export class BundleVerifyError extends RecordError {}

export class CandidateError extends RecordError {}

// The lane's listing of live releases (adoption, design 9.3): a bad tag, or an answer from
// the listing call that is not { entries, requests }.
export class AdoptionListingError extends RecordError {}
