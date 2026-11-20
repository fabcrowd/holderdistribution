#!/usr/bin/env node
/**
 * store-probe.js: measures the GitHub behaviors design 2.1 section 14.6 lists as unmeasured, against a throwaway
 * release series. Never touches the store's own series: every release and tag it makes is named `probe-<id>-<n>`
 * and every delete is refused for any other name (assertProbeTag). It cleans up after itself and prints one JSON
 * result. NOT run by any workflow; run it by hand:
 *
 *   GITHUB_REPOSITORY=<owner/name> GITHUB_TOKEN=<token with contents: write> node scripts/store-probe.js [--upload-mib 32] [--out <file>]
 *
 * Measured (each probe is independent: one failing is recorded and the others still run):
 *   assetCountDuringUpload  the asset count and the asset's state, listed repeatedly while a large upload is in flight
 *   uploadToDeletedRelease  the status and message of an upload into a release deleted just before
 *   prerelease              published_at and created_at of a prerelease made by the API, and whether its body survives
 *                           a read and an upload into it
 *   tagRefAfterDelete       the status of GET /git/ref/tags/<tag> after the release is deleted (200: the tag stays)
 */
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PROBE_PREFIX = "probe-";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const POLL_MS = 250;
const MAX_POLLS = 120;
const MIB = 1024 * 1024;

export function assertProbeTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith(PROBE_PREFIX) || /^data-/.test(tag) || tag.includes("/")) throw new Error(`refusing to touch ${JSON.stringify(tag)}: a probe only works on tags starting with ${PROBE_PREFIX}`);
  return tag;
}

// gh: { createRelease({ tag, body, prerelease }) -> release, getRelease(id) -> release, listAssets(id) -> [{ name, state, size }],
//       uploadAsset(id, name, bytes) -> { status, message }, deleteRelease(id) -> status, getTagRef(tag) -> status,
//       deleteTagRef(tag) -> status }. A release is { id, tag, published_at, created_at, body, prerelease, draft }.
export async function runProbes({ gh, sleep, now = () => new Date().toISOString(), uploadBytes, id = `${Date.now().toString(36)}` }) {
  const result = { schema: 1, id, startedAt: now(), probes: {}, errors: [], cleanup: { releases: [], tags: [], errors: [] } };
  const made = [];
  let n = 0;
  const release = async (body, prerelease = true) => {
    const tag = assertProbeTag(`${PROBE_PREFIX}${id}-${++n}`);
    const rel = await gh.createRelease({ tag, body, prerelease });
    made.push({ id: rel.id, tag });
    return rel;
  };
  const probe = async (name, fn) => {
    try {
      result.probes[name] = await fn();
    } catch (err) {
      result.errors.push({ probe: name, error: `${err.name}: ${err.message}` });
    }
  };

  await probe("assetCountDuringUpload", async () => {
    const rel = await release("probe: asset count during an upload");
    const upload = gh.uploadAsset(rel.id, "probe-large.bin", uploadBytes).then((r) => ({ settled: true, ...r }), (e) => ({ settled: true, status: null, message: String(e.message) }));
    let finished = null;
    upload.then((r) => { finished = r; });
    const samples = [];
    for (let i = 0; i < MAX_POLLS && finished === null; i++) {
      const assets = await gh.listAssets(rel.id);
      samples.push({ count: assets.length, states: assets.map((a) => a.state) });
      await sleep(POLL_MS);
    }
    const reply = await upload;
    const after = await gh.listAssets(rel.id);
    return {
      uploadBytes: uploadBytes.length, uploadStatus: reply.status, samples: samples.length, maxCountDuring: Math.max(0, ...samples.map((s) => s.count)),
      countSeenBeforeUploadFinished: samples.some((s) => s.count > 0), statesSeen: [...new Set(samples.flatMap((s) => s.states))], after: { count: after.length, states: after.map((a) => a.state) },
    };
  });

  await probe("uploadToDeletedRelease", async () => {
    const rel = await release("probe: upload into a deleted release");
    const deleteStatus = await gh.deleteRelease(rel.id);
    const reply = await gh.uploadAsset(rel.id, "probe-after-delete.bin", Buffer.from("probe"));
    return { deleteStatus, uploadStatus: reply.status, uploadMessage: reply.message ?? null };
  });

  await probe("prerelease", async () => {
    const body = `probe body ${id}`;
    const rel = await release(body);
    const read = await gh.getRelease(rel.id);
    await gh.uploadAsset(rel.id, "probe-small.bin", Buffer.from("probe"));
    const readAfterUpload = await gh.getRelease(rel.id);
    return {
      prerelease: read.prerelease, draft: read.draft, createdAt: read.created_at, publishedAt: read.published_at ?? null, publishedAtIsNull: (read.published_at ?? null) === null,
      bodyPersisted: read.body === body, bodyPersistedAfterUpload: readAfterUpload.body === body, publishedAtChangedByUpload: (readAfterUpload.published_at ?? null) !== (read.published_at ?? null),
    };
  });

  await probe("tagRefAfterDelete", async () => {
    const rel = await release("probe: tag after a release delete");
    const before = await gh.getTagRef(rel.tag);
    const deleteStatus = await gh.deleteRelease(rel.id);
    const after = await gh.getTagRef(rel.tag);
    return { tag: rel.tag, tagRefBeforeDelete: before, deleteStatus, tagRefAfterDelete: after, tagSurvivesDelete: after === 200 };
  });

  for (const r of made) {
    try {
      assertProbeTag(r.tag);
      const status = await gh.deleteRelease(r.id);
      result.cleanup.releases.push({ tag: r.tag, status });
      const refStatus = await gh.deleteTagRef(r.tag);
      result.cleanup.tags.push({ tag: r.tag, status: refStatus });
    } catch (err) {
      result.cleanup.errors.push({ tag: r.tag, error: `${err.name}: ${err.message}` });
    }
  }
  result.finishedAt = now();
  return result;
}

// The real client over fetch (injected so nothing here is bound to the network). Every call is on the probe's own
// repository, with the token in the Authorization header only.
export function githubClient({ owner, repo, token, http = fetch }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const call = (method, url, init = {}) => http(url, { method, ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const base = `${API}/repos/${owner}/${repo}`;
  const json = async (res, what) => {
    if (!res.ok) throw new Error(`${what}: status ${res.status}`);
    return res.json();
  };
  return {
    createRelease: async ({ tag, body, prerelease }) => json(await call("POST", `${base}/releases`, { body: JSON.stringify({ tag_name: tag, name: tag, body, prerelease, make_latest: "false" }) }), `create ${tag}`),
    getRelease: async (id) => json(await call("GET", `${base}/releases/${id}`), `get release ${id}`),
    listAssets: async (id) => json(await call("GET", `${base}/releases/${id}/assets?per_page=100`), `list assets of ${id}`),
    uploadAsset: async (id, name, bytes) => {
      const res = await call("POST", `${UPLOADS}/repos/${owner}/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, { body: bytes, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) } });
      const text = await res.text();
      let message = text.slice(0, 300);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {
        // not JSON: keep the text
      }
      return { status: res.status, message };
    },
    deleteRelease: async (id) => (await call("DELETE", `${base}/releases/${id}`)).status,
    getTagRef: async (tag) => (await call("GET", `${base}/git/ref/tags/${assertProbeTag(tag)}`)).status,
    deleteTagRef: async (tag) => (await call("DELETE", `${base}/git/refs/tags/${assertProbeTag(tag)}`)).status,
  };
}

export async function main(argv = process.argv.slice(2), { env = process.env, http = fetch, logger = console } = {}) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--upload-mib", "--out"].includes(argv[i]) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument ${JSON.stringify(argv[i])} (known: --upload-mib <n>, --out <file>)`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  const mib = Number(opts["upload-mib"] ?? 32);
  if (!Number.isInteger(mib) || mib < 1 || mib > 256) throw new Error("--upload-mib must be a whole number from 1 to 256");
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo || !env.GITHUB_TOKEN) throw new Error("GITHUB_REPOSITORY (owner/name) and GITHUB_TOKEN are required");
  const result = await runProbes({ gh: githubClient({ owner, repo, token: env.GITHUB_TOKEN, http }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), uploadBytes: Buffer.alloc(mib * MIB, 1) });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (opts.out) fs.writeFileSync(opts.out, text);
  logger.log(text);
  return result.errors.length === 0 && result.cleanup.errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[store-probe] ${err.message}`);
    process.exitCode = 2;
  });
}
