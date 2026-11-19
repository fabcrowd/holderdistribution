// The creation record of a release (A3 fix). GitHub documents a release's `created_at` as the
// date of the commit the release points at, not the time it was made, so it can read days old
// for a release made a minute ago. The sweep's wait on a release's successor needs the real
// instant, so the process that creates a release writes it into the release body, from its own
// injected clock, as a small JSON record with a schema number. A body that is not such a
// record gives no instant: the creation time is then unknown and the sweep keeps the release.
// `published_at` is also used when the API gives it and it is later than the record: the
// release is as young as the latest evidence says. `created_at` is never read.
export const RECORD_SCHEMA = 1;
const NOTE = "Generated data, written by the pipeline; do not edit or delete by hand";

export const recordText = (ms) => JSON.stringify({ schema: RECORD_SCHEMA, createdAt: new Date(ms).toISOString(), note: NOTE });

// The recorded instant in ms, or null when the text is not a record of this schema.
export function recordedInstant(text) {
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    return null; // a human-written or older body: no instant, not an error
  }
  if (rec === null || typeof rec !== "object" || rec.schema !== RECORD_SCHEMA || typeof rec.createdAt !== "string") return null;
  const ms = Date.parse(rec.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

// ISO creation time of a release as the API describes it ({ body, published_at }), or null when unknown.
export function creationInstant({ body, published_at: publishedAt }) {
  const recorded = recordedInstant(typeof body === "string" ? body : "");
  if (recorded === null) return null;
  const published = typeof publishedAt === "string" ? Date.parse(publishedAt) : Number.NaN;
  return new Date(Number.isNaN(published) ? recorded : Math.max(recorded, published)).toISOString();
}
