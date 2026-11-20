// The blob half of the lane's end step (design 2.1 section 9.1, end step 2, and 4.3's age bound).
// A stored file that is not a table is a blob:
//   - at most BLOB_WHOLE_MAX (16 MiB): one item; unchanged (the sha256 of the file equals the
//     raw sha256 in the item's pack header, read by range, no item read) carries its reference
//   - over that: slices of SLICE_BYTES (8 MiB), one item each under the key `<path>#slice.<n>`
//     (laneNames.js); an unchanged slice carries its reference, a changed one is written
// A reference is carried only while its pack is younger than `carryDays` (historyDays - 30, design
// 4.3), so a blob never holds a pack longer than a base can; an older one is written again.
// Returns { blobs: { <key>: ref }, files: { <path>: sha256 of the whole file }, stats }.
// Memory: one whole blob (16 MiB) or one slice (8 MiB), whatever the file's size.
// Cost per coin: the stored files are read once; one pack-header read per pack a carried reference
// names (shared by every blob of the coin through the reader's cache); writes only for changed bytes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { packNameOf } from "./itemRef.js";
import { parsePackName } from "./packNames.js";
import { BLOB_WHOLE_MAX, FileShrankError, SLICE_BYTES, dayNumber, sliceKey } from "./laneNames.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function hashFile(abs) {
  const h = createHash("sha256");
  for await (const c of createReadStream(abs)) h.update(c);
  return h.digest("hex");
}

// Fills `buf` from `at`; a read may return fewer bytes than asked, and a file that ends early is an error
// (zero padding would be stored as the file's bytes).
export async function readFully(fh, buf, at, file) {
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, at + got);
    if (bytesRead === 0) throw new FileShrankError(file, buf.length, got);
    got += bytesRead;
  }
}

// Can `ref` stand for bytes whose sha256 is `sha`?
async function carried({ ref, sha, startItems, today, carryDays }) {
  if (!ref || !startItems) return false;
  const e = await startItems.entryOf(ref);
  if (e.rawSha256 !== sha) return false;
  return today - dayNumber(parsePackName(packNameOf(ref)).day) < carryDays;
}

export async function packBlobs({ paths, root, views, startItems, previous, day, carryDays }) {
  const today = dayNumber(day);
  const blobs = {};
  const files = {};
  const stats = { carried: 0, written: 0, bytesWritten: 0 };
  const settle = async (key, bytes, info) => {
    const sha = sha256(bytes);
    const ref = previous[key];
    if (await carried({ ref, sha, startItems, today, carryDays })) {
      blobs[key] = ref;
      stats.carried++;
      return;
    }
    blobs[key] = await views.items.put(bytes, info);
    stats.written++;
    stats.bytesWritten += bytes.length;
  };
  for (const rel of paths) {
    const abs = path.resolve(root, rel);
    const st = await fs.stat(abs);
    const madeAt = st.mtime.toISOString();
    files[rel] = await hashFile(abs);
    if (st.size <= BLOB_WHOLE_MAX) {
      await settle(rel, await fs.readFile(abs), { type: "blob", path: rel, madeAt });
      continue;
    }
    const fh = await fs.open(abs, "r");
    try {
      for (let n = 0, at = 0; at < st.size; n++, at += SLICE_BYTES) {
        const buf = Buffer.alloc(Math.min(SLICE_BYTES, st.size - at));
        await readFully(fh, buf, at, rel);
        await settle(sliceKey(rel, n), buf, { type: "slice", path: rel, bucket: n, madeAt });
      }
    } finally {
      await fh.close();
    }
  }
  return { blobs, files, stats };
}
