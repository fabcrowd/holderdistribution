// The release backend of blobStore.js: GitHub REST calls the 2026-11-18 probes used,
// through an injected fetch-shaped `http`. A location is "<release tag>/<name>".
//
// Roll-over (section 7.1): upload() picks the release itself. One count request reads
// the target release's real asset count (Link rel="last" of a per_page=1 listing)
// right before the upload; at `assetLimit` or more the name goes to the next release
// (looked up, or created; a 422 on create means another process made it). Uploads of
// one process into one series run one at a time, so between a count and its upload at
// most P - 1 other uploads land, P = processes uploading into that series at once: a
// release holds at most assetLimit + P - 1 assets. GitHub runs about 20 jobs at once
// (design 14.1), and 900 against GitHub's 1,000 needs P - 1 <= 100. A release that is
// full anyway refuses the upload; any 4xx refusal except auth and rate limits is
// re-counted and rolls over instead of failing. GitHub's real reply at 1,000 assets is
// unmeasured (design 14.6); the fake answers 422, or `hardLimitStatus`.
//
// Identity is the location (see blobStore.js). A crash and a rerun in a new process can
// leave a second copy of a name in a newer release. Readers are not affected: they read
// by location from the pack table the manifest saves. The sweep (A3) removes the copy
// that no manifest names.
//
// The token goes only into Authorization headers of the api and uploads hosts; never
// into a URL, a log line or an error message, and never to the download hosts.
import { Readable } from "node:stream";
import { parseReleaseTag, releaseTag } from "./packNames.js";
import {
  ASSET_LIMIT, MAX_ATTEMPTS, LIST_TRIES, UPLOAD_ROUNDS, owned, parseLoc, checkSeries, checkBounds, sizeOf, chunksOf,
  sha256Of, sha256ByRanges, parallelDownload, StoreNotFoundError, StoreNameTakenError, StoreHttpError,
  StoreRateLimitError, StoreRangeError, StoreListingError, StoreUploadError,
} from "./blobStore.js";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const WEB = "https://github.com";
const PER_PAGE = 100;
const RELEASE_BODY = "Generated data, written by the pipeline; do not edit or delete by hand";
const DIGEST = /^sha256:([0-9a-f]{64})$/;

const isRate = (res) =>
  res.status === 429 || (res.status === 403 && (res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0"));

function rateWaitMs(res, now) {
  const after = res.headers.get("retry-after");
  if (after !== null) return Number(after) * 1000;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) ? Math.max(0, reset * 1000 - now()) + 1000 : 60_000;
}

function lastPage(res) {
  const m = (res.headers.get("link") ?? "").match(/[?&]page=(\d+)>; rel="last"/);
  return m ? Number(m[1]) : null;
}

function transport({ http, now, sleep, maxRateWaitMs, stats }) {
  // One logical request: retries 5xx and dropped connections with backoff and waits
  // through rate limits up to maxRateWaitMs; at most MAX_ATTEMPTS sends.
  return async function call(label, url, makeInit = {}, { core = 1, kind = "api" } = {}) {
    let last = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      stats.core += core;
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      let res;
      try {
        res = await http(url, { redirect: "manual", ...(typeof makeInit === "function" ? makeInit() : makeInit) });
      } catch (err) {
        last = `connection failed (${err?.cause?.code ?? err?.name ?? "error"})`;
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (isRate(res)) {
        const wait = rateWaitMs(res, now);
        if (wait > maxRateWaitMs || attempt === MAX_ATTEMPTS) throw new StoreRateLimitError(`${label}: rate limited (${res.status}), reset in ${Math.round(wait / 1000)} s`);
        await sleep(wait);
        continue;
      }
      if (res.status < 500) return res;
      last = `status ${res.status}`;
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
    }
    throw new StoreHttpError(`${label}: ${last} after ${MAX_ATTEMPTS} attempts`);
  };
}

export function releaseBackend({ owner, repo, token, http, now = Date.now, sleep, assetLimit = ASSET_LIMIT, maxRateWaitMs = 5 * 60_000, seqs = {} }) {
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const repoPath = `/repos/${owner}/${repo}`;
  const stats = { core: 0, byKind: {} };
  const call = transport({ http, now, sleep, maxRateWaitMs, stats });
  const rels = new Map(); // tag -> { id, tag, seq, series }
  const current = new Map(); // series -> seq
  const assets = new Map(); // loc -> { id, name, size, state, digest, createdAt, tag }, from listings and uploads
  const loaded = new Set(); // series whose listing is cached (hits and misses)
  const sizes = new Map(); // loc -> size
  const signed = new Map(); // loc -> Promise<signed url | null>
  const posted = new Map(); // name -> tag this process last posted it to
  const queues = new Map(); // series -> tail of this process's upload queue
  const fail = (label, res) => new StoreHttpError(`${label}: unexpected status ${res.status}`);
  const api = (label, p, init = {}) => call(label, API + repoPath + p, () => ({ ...init, headers: { ...auth, ...init.headers } }));

  async function countOf(label, p) {
    const res = await api(label, `${p}?per_page=1&page=1`);
    if (res.status !== 200) throw fail(label, res);
    return lastPage(res) ?? (await res.json()).length;
  }
  // Every page, deduplicated by id, between two counts; both counts and the items seen
  // must agree, else the listing is read again (a delete between pages can hide an
  // item while a stale one fills its place). Never returned short.
  async function pages(label, p) {
    for (let tries = 1; tries <= LIST_TRIES; tries++) {
      const before = await countOf(label, p);
      const seen = new Map();
      for (let page = 1; ; page++) {
        const res = await api(label, `${p}?per_page=${PER_PAGE}&page=${page}`);
        if (res.status !== 200) throw fail(label, res);
        for (const r of await res.json()) seen.set(r.id, r);
        if (!/rel="next"/.test(res.headers.get("link") ?? "")) break;
      }
      if (before === (await countOf(label, p)) && before === seen.size) return [...seen.values()];
    }
    throw new StoreListingError(`${label}: listing changed while it was read, ${LIST_TRIES} times`);
  }

  function addRelease(r) {
    const t = parseReleaseTag(r.tag_name);
    if (!rels.has(r.tag_name)) rels.set(r.tag_name, { id: r.id, tag: r.tag_name, seq: t.seq, series: t.series });
    return rels.get(r.tag_name);
  }
  function remember(tag, a) {
    const loc = `${tag}/${a.name}`;
    assets.set(loc, { id: a.id, name: a.name, size: a.size, state: a.state, digest: a.digest ?? null, createdAt: a.created_at, tag });
    return loc;
  }
  function forget(loc) {
    assets.delete(loc);
    sizes.delete(loc);
    signed.delete(loc);
  }
  async function releaseByTag(tag, { create = false } = {}) {
    if (rels.has(tag)) return rels.get(tag);
    const got = await api(`get ${tag}`, `/releases/tags/${tag}`);
    if (got.status === 200) return addRelease(await got.json());
    if (got.status !== 404) throw fail(`get ${tag}`, got);
    if (!create) throw new StoreNotFoundError(`no release ${tag}`);
    const res = await api(`create ${tag}`, "/releases", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: tag, name: tag, prerelease: true, make_latest: "false", body: RELEASE_BODY }),
    });
    if (res.status === 201) return addRelease(await res.json());
    if (res.status !== 422) throw fail(`create ${tag}`, res);
    return releaseByTag(tag); // another process created it: use it
  }
  const countRelease = (rel) => countOf(`count ${rel.tag}`, `/releases/${rel.id}/assets`);

  // The release the next upload of the series goes to, by its real count.
  async function target(series) {
    let seq = current.get(series) ?? seqs[series] ?? 1;
    for (;;) {
      const rel = await releaseByTag(releaseTag(series, seq), { create: true });
      if ((await countRelease(rel)) < assetLimit) {
        current.set(series, seq);
        return rel;
      }
      seq++;
    }
  }

  async function listRelease(rel) {
    const rows = await pages(`list ${rel.tag}`, `/releases/${rel.id}/assets`);
    for (const [loc, a] of assets) if (a.tag === rel.tag) assets.delete(loc);
    return rows.map((a) => ({ a, loc: remember(rel.tag, a) }));
  }
  // GitHub lists releases newest first, and the series interleave in creation order, so
  // paging cannot stop early at a series boundary: every page of the release list is read.
  async function listSeries(series) {
    checkSeries(series);
    for (const r of await pages("list releases", "/releases")) {
      try { addRelease(r); } catch { /* not a store release */ }
    }
    const out = [];
    for (const rel of [...rels.values()].filter((r) => r.series === series).sort((x, y) => x.seq - y.seq)) {
      for (const { a, loc } of await listRelease(rel)) out.push({ name: a.name, size: a.size, createdAt: a.created_at, release: rel.tag, state: a.state, loc });
    }
    loaded.add(series);
    return out;
  }
  async function find(name) {
    const { series } = owned(name);
    if (!loaded.has(series)) await listSeries(series);
    return [...assets.entries()].filter(([, a]) => a.name === name && rels.get(a.tag)?.series === series)
      .map(([loc, a]) => ({ name, size: a.size, createdAt: a.createdAt, release: a.tag, state: a.state, loc }));
  }

  // Signed URL from the public download URL: no token and no core request (section 14.3).
  function location(loc) {
    if (!signed.has(loc)) {
      const { tag, name } = parseLoc(loc);
      const p = (async () => {
        const res = await call(`resolve ${loc}`, `${WEB}/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`, {}, { core: 0, kind: "download" });
        if (res.status === 404) return null;
        const to = res.headers.get("location");
        if (res.status !== 302 || !to) throw fail(`resolve ${loc}`, res);
        return to;
      })();
      p.then((v) => v === null && signed.delete(loc), () => signed.delete(loc));
      signed.set(loc, p);
    }
    return signed.get(loc);
  }

  // Size by location, from a one-byte range read: no core request and no listing.
  async function statLoc(loc) {
    if (sizes.has(loc)) return sizes.get(loc);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const url = await location(loc);
      if (url === null) return null;
      const res = await call(`stat ${loc}`, url, { headers: { Range: "bytes=0-0" } }, { core: 0, kind: "signedRead" });
      const m = (res.headers.get("content-range") ?? "").match(/^bytes (?:0-0|\*)\/(\d+)$/);
      if ((res.status === 206 || res.status === 416) && m) {
        sizes.set(loc, Number(m[1]));
        return Number(m[1]);
      }
      signed.delete(loc);
    }
    throw new StoreRangeError(`stat ${loc}: no usable content-range after ${MAX_ATTEMPTS} attempts`);
  }

  async function readRange(loc, offset, length) {
    const size = await statLoc(loc);
    if (size === null) throw new StoreNotFoundError(`not found: ${loc}`);
    checkBounds(loc, size, offset, length);
    if (length === 0) return Buffer.alloc(0);
    const want = `bytes ${offset}-${offset + length - 1}/${size}`;
    let last = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const url = await location(loc);
      if (url === null) throw new StoreNotFoundError(`not found: ${loc}`);
      const res = await call(`read ${loc}`, url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } }, { core: 0, kind: "signedRead" });
      if (res.status === 206 && res.headers.get("content-range") === want) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === length) return buf;
        last = `short body ${buf.length} of ${length}`;
      } else {
        last = res.status === 206 ? `content-range ${res.headers.get("content-range")}, wanted ${want}` : `status ${res.status}`;
        if (res.status !== 206) signed.delete(loc); // an expired signed URL is fetched again
      }
    }
    throw new StoreRangeError(`read ${loc} ${offset}+${length}: ${last} after ${MAX_ATTEMPTS} attempts`);
  }

  async function deleteAt(loc, id) {
    const res = await api(`delete ${loc}`, `/releases/assets/${id}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 404) throw fail(`delete ${loc}`, res); // 404: a retry after the server deleted it
    forget(loc);
  }

  // Equal content: the asset's `digest` ("sha256:<hex>") when the API gives one, else
  // the asset read back by range and hashed (0 core requests; its size in bytes).
  async function sameContent(loc, a, source) {
    const want = await sha256Of(source);
    const m = (a.digest ?? "").match(DIGEST);
    if (m) return m[1] === want;
    return a.size === sizeOf(source) && (await sha256ByRanges(readRange, loc, a.size)) === want;
  }

  function postAsset(rel, name, source) {
    return call(`upload ${name}`, `${UPLOADS}${repoPath}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, () => ({
      method: "POST", body: Buffer.isBuffer(source) ? source : Readable.from(chunksOf(source)), duplex: "half",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(sizeOf(source)) },
    }), { core: 2, kind: "upload" }); // the upload host costs about 2 core requests (REPORT-actions)
  }

  // The name in release `rel`, read from a listing of that release: "stored" when it is
  // readable with equal bytes, StoreNameTakenError when readable with other bytes, and
  // "absent" after deleting an asset that never became readable (or when there is none).
  async function existingIn(rel, name, source) {
    await listRelease(rel);
    const loc = `${rel.tag}/${name}`;
    const a = assets.get(loc);
    if (!a) return "absent";
    if (a.state !== "uploaded") {
      await deleteAt(loc, a.id);
      return "deleted";
    }
    if (await sameContent(loc, a, source)) return "stored";
    throw new StoreNameTakenError(`${loc} is already stored with other content`);
  }

  // A refusal at the limit must not depend on GitHub answering 422 (design 14.6). Any 4xx
  // other than 401, 403 and 429 (auth and rate limits) is re-counted: at the limit it
  // rolls over. A 422 is first checked for the name already in the release (stored, or a
  // dead upload now deleted: try again). Every other refusal, and any 4xx below the
  // limit, is surfaced with its real status; the rounds bound the roll-overs.
  async function onRefused(res, rel, name, source) {
    const s = res.status;
    if (s < 400 || s >= 500 || s === 401 || s === 403 || s === 429) throw fail(`upload ${name}`, res);
    if (s === 422) {
      const was = await existingIn(rel, name, source);
      if (was === "stored") return "stored";
      if (was === "deleted") return "again";
    }
    if ((await countRelease(rel)) >= assetLimit) return "full";
    throw fail(`upload ${name}`, res);
  }

  async function uploadNow(name, source) {
    const { series } = owned(name);
    const size = sizeOf(source);
    // An upload of this name that this process posted before (it may have been stored and
    // reported failed): that release is checked first, so a retry after a roll-over does
    // not store a second copy.
    if (posted.has(name)) {
      const rel = await releaseByTag(posted.get(name));
      if ((await existingIn(rel, name, source)) === "stored") return { name, size, loc: `${rel.tag}/${name}` };
    }
    for (let round = 1; round <= UPLOAD_ROUNDS; round++) {
      const rel = await target(series);
      const loc = `${rel.tag}/${name}`;
      posted.set(name, rel.tag);
      const res = await postAsset(rel, name, source);
      if (res.status === 201) {
        remember(rel.tag, await res.json());
        sizes.set(loc, size);
        return { name, size, loc };
      }
      const next = await onRefused(res, rel, name, source);
      if (next === "stored") return { name, size, loc };
      if (next === "full") current.set(series, rel.seq + 1);
    }
    throw new StoreUploadError(`upload ${name}: still refused after ${UPLOAD_ROUNDS} rounds`);
  }

  // One upload at a time per series in this process (the roll-over bound above).
  async function upload(name, source) {
    const { series } = owned(name);
    const run = (queues.get(series) ?? Promise.resolve()).then(() => uploadNow(name, source));
    queues.set(series, run.catch(() => {}));
    return run;
  }

  return {
    upload,
    readRange,
    async download(loc, sink, opts) {
      const size = await statLoc(loc);
      if (size === null) throw new StoreNotFoundError(`not found: ${loc}`);
      return parallelDownload(readRange, loc, size, sink, opts);
    },
    list: listSeries,
    find,
    refresh(series) { checkSeries(series); loaded.delete(series); },
    // The asset id comes from the cached series listing (the sweep lists first).
    async delete(loc) {
      const { name } = parseLoc(loc);
      owned(name, { forDelete: true });
      let a = assets.get(loc);
      if (!a) { await find(name); a = assets.get(loc); }
      if (!a) throw new StoreNotFoundError(`not found: ${loc}`);
      await deleteAt(loc, a.id);
    },
    // Fresh each time (no size cache), so another process's delete is seen.
    async exists(loc) {
      parseLoc(loc);
      sizes.delete(loc);
      signed.delete(loc);
      return (await statLoc(loc)) !== null;
    },
    async stat(loc) {
      const size = await statLoc(loc);
      return size === null ? null : { size, loc };
    },
    stats: () => ({ core: stats.core, byKind: { ...stats.byKind } }),
  };
}
