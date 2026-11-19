// The one seam through which the table code reads and writes bytes. Later slices
// put packs behind the same interface. A ref is an opaque string: here the sha256
// of the bytes, so a put of the same bytes is idempotent.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const refOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const REF = /^[0-9a-f]{64}$/;

function missing(ref) {
  return new Error(`item store: missing item ${ref}`);
}

function checkRange(ref, size, offset, length) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`item store: range ${offset}+${length} outside item ${ref} of ${size} bytes`);
  }
}

export function createMemoryStore() {
  // `items` is exposed so tests can corrupt a stored item in place.
  const items = new Map();
  return {
    items,
    async put(bytes) {
      const ref = refOf(bytes);
      if (!items.has(ref)) items.set(ref, Buffer.from(bytes));
      return ref;
    },
    async get(ref) {
      const b = items.get(ref);
      if (!b) throw missing(ref);
      return Buffer.from(b);
    },
    async getRange(ref, offset, length) {
      const b = items.get(ref);
      if (!b) throw missing(ref);
      checkRange(ref, b.length, offset, length);
      return Buffer.from(b.subarray(offset, offset + length));
    },
    async has(ref) {
      return items.has(ref);
    },
    async delete(ref) {
      items.delete(ref);
    },
    async list() {
      return [...items.keys()].sort();
    },
  };
}

export function createFolderStore(dir) {
  const file = (ref) => {
    if (!REF.test(ref)) throw new Error(`item store: bad ref ${ref}`);
    return path.join(dir, `${ref}.bin`);
  };
  const absent = (err) => err && err.code === "ENOENT";
  return {
    async put(bytes) {
      const ref = refOf(bytes);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file(ref)}.${process.pid}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file(ref));
      return ref;
    },
    async get(ref) {
      try {
        return await fs.readFile(file(ref));
      } catch (err) {
        if (absent(err)) throw missing(ref);
        throw err;
      }
    },
    async getRange(ref, offset, length) {
      let fh;
      try {
        fh = await fs.open(file(ref), "r");
      } catch (err) {
        if (absent(err)) throw missing(ref);
        throw err;
      }
      try {
        const { size } = await fh.stat();
        checkRange(ref, size, offset, length);
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, offset);
        return buf;
      } finally {
        await fh.close();
      }
    },
    async has(ref) {
      try {
        await fs.access(file(ref));
        return true;
      } catch (err) {
        if (absent(err)) return false;
        throw err;
      }
    },
    async delete(ref) {
      await fs.rm(file(ref), { force: true });
    },
    async list() {
      let names;
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        if (absent(err)) return [];
        throw err;
      }
      return names.filter((n) => n.endsWith(".bin")).map((n) => n.slice(0, -4)).sort();
    },
  };
}
