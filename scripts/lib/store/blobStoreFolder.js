// The folder backend of blobStore.js, for tests and local runs: one subfolder per
// release, laid out like the release backend, with the same location form
// "<release tag>/<name>", operations and errors. A file is stored by an exclusive
// link from a temporary file, never by a rename over an existing one, so of two
// uploads of one name into one release exactly one stores its bytes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseReleaseTag, releaseTag } from "./packNames.js";
import { recordText, recordedInstant } from "./releaseRecord.js";
import {
  ASSET_LIMIT, owned, ownedReleaseTag, checkSeries, checkBounds, sizeOf, chunksOf, sha256Of, parallelDownload, parseLoc,
  StoreNotFoundError, StoreNameTakenError, StoreRangeError, StoreReleaseNotEmptyError,
} from "./blobStore.js";

async function hashFile(file) {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest("hex");
}

// The creation record of release <tag> is the file <dir>/.release-records/<tag>.json (releaseRecord.js),
// written by the process that makes the folder, from its own clock. It sits beside the release folders,
// not in them, so a folder holds only assets and rmdir still tells whether it is empty. A folder with no
// record (made by hand, or by an older run) has an unknown creation time. The record outlives its folder, as
// a git tag outlives its release: a record with no folder means the number was used and the release deleted,
// so currentTag never goes back to it (a crash that leaves a record behind only skips one number).
const RECORDS = ".release-records";

export function folderBackend(dir, { assetLimit = ASSET_LIMIT, now = Date.now } = {}) {
  const recordFile = (tag) => path.join(dir, RECORDS, `${tag}.json`);
  async function writeRecord(tag) {
    await fs.mkdir(path.join(dir, RECORDS), { recursive: true });
    await fs.writeFile(recordFile(tag), recordText(now()), { flag: "wx" }).catch((e) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
  }
  const isTmp = (n) => n.includes(".tmp-");
  async function releases(series) {
    const names = await fs.readdir(dir).catch((e) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
    return names.map((n) => { try { return parseReleaseTag(n); } catch { return null; } })
      .filter((t) => t && t.series === series).sort((a, b) => a.seq - b.seq).map((t) => releaseTag(t.series, t.seq));
  }
  const files = async (tag) => (await fs.readdir(path.join(dir, tag))).filter((n) => !isTmp(n));
  const fileOf = (loc) => { const { tag, name } = parseLoc(loc); return path.join(dir, tag, name); };
  async function statFile(loc) {
    const st = await fs.stat(fileOf(loc)).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    return st && { size: st.size, createdAt: st.mtime.toISOString() };
  }
  // Decided by the folder's real count before every upload.
  async function currentTag(series) {
    const tags = await releases(series);
    const marked = (await fs.readdir(path.join(dir, RECORDS)).catch((e) => (e.code === "ENOENT" ? [] : Promise.reject(e))))
      .map((n) => { try { return parseReleaseTag(n.replace(/\.json$/, "")); } catch { return null; } }).filter((t) => t && t.series === series).map((t) => t.seq);
    const top = Math.max(0, ...marked, ...tags.map((t) => parseReleaseTag(t).seq));
    let seq = top === 0 ? 1 : tags.includes(releaseTag(series, top)) ? top : top + 1;
    for (;;) {
      const tag = releaseTag(series, seq);
      await fs.mkdir(path.join(dir, tag), { recursive: true }); // a second lane's mkdir is "use it"
      await writeRecord(tag); // kept if one is there: the first lane's instant stands
      if ((await files(tag)).length < assetLimit) return tag;
      seq++;
    }
  }
  async function writeTmp(tag, name, source) {
    const tmp = path.join(dir, tag, `${name}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const fh = await fs.open(tmp, "wx");
    try {
      for await (const c of chunksOf(source)) await fh.write(c);
    } finally {
      await fh.close();
    }
    return tmp;
  }
  // One upload at a time per series in this backend object, as on releases, so the
  // roll-over overshoot is at most the processes uploading at once, minus one.
  const queues = new Map();
  function queued(series, fn) {
    const run = (queues.get(series) ?? Promise.resolve()).then(fn);
    queues.set(series, run.catch(() => {}));
    return run;
  }
  const store = {
    upload: async (name, source) => queued(owned(name).series, () => uploadNow(name, source)),
  };
  async function uploadNow(name, source) {
    {
      const { series } = owned(name);
      const size = sizeOf(source);
      const tag = await currentTag(series);
      const loc = `${tag}/${name}`;
      const tmp = await writeTmp(tag, name, source);
      try {
        await fs.link(tmp, fileOf(loc));
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Stored already, by us earlier or by another process: equal bytes are that object.
        if ((await hashFile(fileOf(loc))) === (await sha256Of(source))) return { name, size, loc };
        throw new StoreNameTakenError(`${loc} is already stored with other content`);
      } finally {
        await fs.rm(tmp, { force: true });
      }
      return { name, size, loc };
    }
  }
  Object.assign(store, {
    async readRange(loc, offset, length) {
      const st = await statFile(loc);
      if (!st) throw new StoreNotFoundError(`not found: ${loc}`);
      checkBounds(loc, st.size, offset, length);
      const fh = await fs.open(fileOf(loc), "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        if (bytesRead !== length) throw new StoreRangeError(`short read of ${loc}: ${bytesRead} of ${length}`);
        return buf;
      } finally {
        await fh.close();
      }
    },
    async download(loc, sink, opts) {
      const st = await statFile(loc);
      if (!st) throw new StoreNotFoundError(`not found: ${loc}`);
      return parallelDownload(store.readRange, loc, st.size, sink, opts);
    },
    async list(series) {
      checkSeries(series);
      const out = [];
      for (const tag of await releases(series)) {
        for (const n of await files(tag)) {
          const st = await fs.stat(path.join(dir, tag, n));
          out.push({ name: n, size: st.size, createdAt: st.mtime.toISOString(), release: tag, state: "uploaded", loc: `${tag}/${n}` });
        }
      }
      return out;
    },
    async find(name) {
      return (await store.list(owned(name).series)).filter((e) => e.name === name);
    },
    async delete(loc) {
      owned(parseLoc(loc).name, { forDelete: true });
      if (!(await statFile(loc))) throw new StoreNotFoundError(`not found: ${loc}`);
      await fs.rm(fileOf(loc), { force: true });
    },
    async exists(loc) {
      return (await statFile(loc)) !== null;
    },
    async stat(loc) {
      const st = await statFile(loc);
      return st && { size: st.size, loc };
    },
    async releasesOf(series) {
      checkSeries(series);
      const out = [];
      for (const tag of await releases(series)) {
        const text = await fs.readFile(recordFile(tag), "utf8").catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
        const ms = recordedInstant(text);
        out.push({ tag, seq: parseReleaseTag(tag).seq, assets: (await files(tag)).length, createdAt: ms === null ? null : new Date(ms).toISOString() });
      }
      return out;
    },
    async deleteRelease(tag) {
      ownedReleaseTag(tag);
      const folder = path.join(dir, tag);
      const held = await fs.readdir(folder).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
      if (held === null) throw new StoreNotFoundError(`no release ${tag}`);
      if (held.length) throw new StoreReleaseNotEmptyError(`refused: release ${tag} still holds ${held.length} asset(s)`);
      // rmdir, never a recursive remove: a file that landed since the check keeps the folder.
      await fs.rmdir(folder).catch((e) => (e.code === "ENOTEMPTY" ? Promise.reject(new StoreReleaseNotEmptyError(`refused: release ${tag} still holds an asset`)) : Promise.reject(e)));
    },
    refresh() {},
    stats: () => ({ core: 0, byKind: {} }),
  });
  return store;
}
