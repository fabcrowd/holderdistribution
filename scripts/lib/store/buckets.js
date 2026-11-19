// Linear hashing (design 2.1, 3.1). A layout is { L, p } with B = 2^L + p buckets.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(key) {
  const bytes = Buffer.from(key, "utf8");
  let h = FNV_OFFSET;
  for (const b of bytes) h = Math.imul(h ^ b, FNV_PRIME) >>> 0;
  return h >>> 0;
}

export const bucketCount = ({ L, p }) => 2 ** L + p;

export function bucketOfHash(h, layout) {
  const m = h % 2 ** (layout.L + 1);
  return m < bucketCount(layout) ? m : h % 2 ** layout.L;
}

export const bucketOf = (key, layout) => bucketOfHash(fnv1a32(key), layout);

// One split: bucket p into p and p + 2^L, then p grows (at 2^L, L grows and p returns to 0).
export function splitLayout({ L, p }) {
  const event = { split: p, into: p + 2 ** L, L };
  const np = p + 1;
  return { layout: np === 2 ** L ? { L: L + 1, p: 0 } : { L, p: np }, event };
}

// The bucket of an older (coarser or equal) layout that holds every key of `bucket`.
// Bucket c >= 1 was made by splitting c - 2^floor(log2 c).
export function ancestorIn(bucket, layout) {
  const B = bucketCount(layout);
  let b = bucket;
  while (b >= B) b -= 2 ** Math.floor(Math.log2(b));
  return b;
}

// The buckets that hold a bucket's keys after the given split events (in order).
export function lineage(bucket, events) {
  const s = new Set([bucket]);
  for (const e of events) if (s.has(e.split)) s.add(e.into);
  return [...s].sort((a, b) => a - b);
}

export function layoutForRows(rows, rowsPerBucket) {
  let layout = { L: 0, p: 0 };
  while (rows > bucketCount(layout) * rowsPerBucket) layout = splitLayout(layout).layout;
  return layout;
}
