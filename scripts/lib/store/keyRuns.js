// Sorted key runs on disk and their merge: how a table format puts rows that arrive bucket by bucket
// (hash order) back into one sorted file without holding the file (tableFormats.js).
//
// A run is a file of keys, one per line, sorted by UTF-16 code units (Array.prototype.sort's order, which
// is also what `<` compares). A key may not hold a line break (the formats refuse control characters).
// writeRun sorts the keys it is given (one bucket, at most about 2R keys: design 3.1) and mergeKeys
// reads any number of runs back as one sorted stream, one line per run in memory. mergeRuns cuts the
// number of open files to `fanIn` by merging groups into new runs first.
// Memory: one bucket's keys while a run is written; fanIn lines plus one read buffer per open run while
// merging. Disk: the keys twice at most (runs, then their merged runs, the inputs deleted as they are
// merged). Cost: every key is written and read once per pass; passes = ceil(log_fanIn(runs)), 1 up to
// fanIn runs (fanIn 64: one pass up to 64 buckets, about 16 million rows).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const WRITE_BATCH_CHARS = 1 << 18;

// Writes the strings of an (async) iterable to `file` in batches; a sequential await per batch is the backpressure.
export async function writeText(file, parts) {
  const fh = await fsp.open(file, "w");
  try {
    let batch = [];
    let size = 0;
    for await (const part of parts) {
      batch.push(part);
      size += part.length;
      if (size >= WRITE_BATCH_CHARS) {
        await fh.write(batch.join(""));
        batch = [];
        size = 0;
      }
    }
    if (batch.length > 0) await fh.write(batch.join(""));
  } finally {
    await fh.close();
  }
}

export async function writeRun(file, keys) {
  keys.sort();
  await writeText(file, (function* lines() {
    for (const k of keys) yield `${k}\n`;
  })());
}

// The keys of the runs in sorted order. A key that two runs both hold is an error of the caller (a key
// belongs to one bucket), reported through `onDuplicate`.
export async function* mergeKeys(files, onDuplicate) {
  const readers = files.map((f) => readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity })[Symbol.asyncIterator]());
  try {
    const heads = await Promise.all(readers.map((r) => r.next()));
    let last = null;
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) if (!heads[i].done && (best < 0 || heads[i].value < heads[best].value)) best = i;
      if (best < 0) return;
      const key = heads[best].value;
      if (key === last) onDuplicate(key);
      last = key;
      yield key;
      heads[best] = await readers[best].next();
    }
  } finally {
    await Promise.all(readers.map((r) => r.return?.()));
  }
}

// Merges groups of runs until at most `fanIn` remain; returns their files (in dir).
export async function mergeRuns(files, { dir, fanIn, onDuplicate }) {
  let runs = files;
  for (let pass = 0; runs.length > fanIn; pass++) {
    const next = [];
    for (let i = 0; i < runs.length; i += fanIn) {
      const group = runs.slice(i, i + fanIn);
      const out = path.join(dir, `m${pass}-${i / fanIn}`);
      await writeText(out, (async function* lines() {
        for await (const k of mergeKeys(group, onDuplicate)) yield `${k}\n`;
      })());
      await Promise.all(group.map((f) => fsp.rm(f, { force: true })));
      next.push(out);
    }
    runs = next;
  }
  return runs;
}
