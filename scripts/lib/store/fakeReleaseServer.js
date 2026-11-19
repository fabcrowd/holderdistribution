// Test helper: an in-memory `fetch`-shaped server for exactly the GitHub REST calls the
// release backend makes, behaving as the 2026-11-18 probes measured (store-probe
// REPORT-actions.md, REPORT-local.md): prereleases (422 on an existing tag), asset
// listings 100 a page with a Link header, uploads on a separate host (422 on a duplicate
// name), deletes, downloads through a 302 to a signed URL that answers Range with 206
// and must not see the token. Fault switches fail a chosen request; counts by kind.
import { createHash } from "node:crypto";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const WEB = "https://github.com";
const SIGNED = "https://release-assets.example.test";

const json = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function bodyBytes(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  const parts = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

function header(init, name) {
  const h = init?.headers ?? {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k === undefined ? null : h[k];
}

// `digests`: give assets GitHub's `digest` field ("sha256:<hex>"; the REST page of
// 2026-03-10 lists it as string or null), or null to force the read-back path.
export function createFakeReleaseServer({ owner = "o", repo = "r", token = "secret-token", perPage = 100, clock = { t: 0 }, hardLimit = 1000, hardLimitStatus = 422, digests = true } = {}) {
  const releases = []; // { id, tag_name, name, prerelease, make_latest, body, assets: [] }
  const counts = {};
  const faults = []; // { at, type, kind }
  let nextId = 1000;
  let seen = 0;
  const base = `/repos/${owner}/${repo}`;
  const count = (k) => { counts[k] = (counts[k] ?? 0) + 1; };

  const assetJson = (rel, a) => ({
    id: a.id, name: a.name, size: a.bytes.length, state: a.state, created_at: a.createdAt,
    digest: digests && a.state === "uploaded" ? `sha256:${createHash("sha256").update(a.bytes).digest("hex")}` : null,
    browser_download_url: `${WEB}/${owner}/${repo}/releases/download/${rel.tag_name}/${a.name}`,
  });
  const findAsset = (id) => {
    for (const rel of releases) for (const a of rel.assets) if (a.id === id) return { rel, a };
    return null;
  };

  function takeFault(kind) {
    const i = faults.findIndex((f) => f.at === seen && (!f.kind || f.kind === kind));
    return i < 0 ? null : faults.splice(i, 1)[0];
  }

  function rateReply(type) {
    if (type === "rate403") return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(clock.t / 1000) + 5) });
    return json(429, { message: "secondary rate limit" }, { "retry-after": "3" });
  }

  function pageOf(list, url, mk) {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), perPage);
    const page = Number(url.searchParams.get("page") ?? 1);
    const last = Math.ceil(list.length / per);
    // Like GitHub: no Link header when everything fits on one page.
    const at = (n) => `<${url.origin}${url.pathname}?per_page=${per}&page=${n}>`;
    const links = last > 1 ? [page < last ? `${at(page + 1)}; rel="next"` : null, `${at(last)}; rel="last"`].filter(Boolean) : [];
    return json(200, list.slice((page - 1) * per, page * per).map(mk), links.length ? { link: links.join(", ") } : {});
  }

  async function api(method, url, init, fault) {
    const p = url.pathname;
    if (header(init, "authorization") !== `Bearer ${token}`) return json(401, { message: "Bad credentials" });
    if (method === "POST" && p === `${base}/releases`) {
      count("createRelease");
      const b = JSON.parse((await bodyBytes(init.body)).toString());
      if (releases.some((r) => r.tag_name === b.tag_name)) return json(422, { message: "Validation Failed", errors: [{ code: "already_exists", field: "tag_name" }] });
      const rel = { id: nextId++, ...b, assets: [] };
      releases.push(rel);
      return json(201, { id: rel.id, tag_name: rel.tag_name, prerelease: rel.prerelease });
    }
    let m = p.match(new RegExp(`^${base}/releases/tags/(.+)$`));
    if (method === "GET" && m) {
      count("getRelease");
      const rel = releases.find((r) => r.tag_name === decodeURIComponent(m[1]));
      return rel ? json(200, { id: rel.id, tag_name: rel.tag_name, prerelease: rel.prerelease }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && p === `${base}/releases`) {
      count("listReleases");
      return pageOf(releases, url, (r) => ({ id: r.id, tag_name: r.tag_name, prerelease: r.prerelease }));
    }
    m = p.match(new RegExp(`^${base}/releases/(\\d+)/assets$`));
    if (method === "GET" && m) {
      count("listAssets");
      const rel = releases.find((r) => r.id === Number(m[1]));
      if (!rel) return json(404, { message: "Not Found" });
      if (fault?.type === "shiftListing" && rel.assets.length) rel.assets.shift();
      return pageOf(rel.assets, url, (a) => assetJson(rel, a));
    }
    m = p.match(new RegExp(`^${base}/releases/assets/(\\d+)$`));
    if (method === "DELETE" && m) {
      count("deleteAsset");
      const hit = findAsset(Number(m[1]));
      if (!hit) return json(404, { message: "Not Found" });
      hit.rel.assets.splice(hit.rel.assets.indexOf(hit.a), 1);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: `fake: no route ${method} ${p}` });
  }

  async function upload(url, init, fault) {
    count("upload");
    if (header(init, "authorization") !== `Bearer ${token}`) return json(401, { message: "Bad credentials" });
    const m = url.pathname.match(new RegExp(`^${base}/releases/(\\d+)/assets$`));
    const rel = m && releases.find((r) => r.id === Number(m[1]));
    if (!rel) return json(404, { message: "Not Found" });
    const name = url.searchParams.get("name");
    const bytes = await bodyBytes(init.body);
    if (rel.assets.some((a) => a.name === name)) return json(422, { message: "Validation Failed", errors: [{ code: "already_exists", field: "name" }] });
    // GitHub's reply at its 1,000-asset limit is unmeasured (design 14.6); the fake refuses with 422.
    if (rel.assets.length >= hardLimit) return json(hardLimitStatus, { message: "Validation Failed", errors: [{ code: "custom", message: "too many assets" }] });
    if (fault?.type === "storePartial") {
      rel.assets.push({ id: nextId++, name, bytes: bytes.subarray(0, bytes.length >> 1), state: "starter", createdAt: new Date(clock.t).toISOString() });
      return Promise.reject(new TypeError("fetch failed: socket closed"));
    }
    const a = { id: nextId++, name, bytes, state: "uploaded", createdAt: new Date(clock.t).toISOString() };
    rel.assets.push(a);
    if (fault?.type === "storeThenFail") return json(502, { message: "Bad Gateway" });
    return json(201, assetJson(rel, a));
  }

  function web(url) {
    count("download");
    const m = url.pathname.match(new RegExp(`^/${owner}/${repo}/releases/download/([^/]+)/([^/]+)$`));
    const rel = m && releases.find((r) => r.tag_name === decodeURIComponent(m[1]));
    const a = rel && rel.assets.find((x) => x.name === decodeURIComponent(m[2]));
    if (!a) return new Response("Not Found", { status: 404 });
    return new Response(null, { status: 302, headers: { location: `${SIGNED}/a/${a.id}?sig=${clock.t}` } });
  }

  function signed(url, init, fault) {
    count("signedRead");
    if (header(init, "authorization")) return new Response("token sent to signed host", { status: 400 });
    const hit = findAsset(Number(url.pathname.split("/").pop()));
    if (!hit) return new Response("Not Found", { status: 404 });
    const bytes = hit.a.bytes;
    const range = header(init, "range");
    if (!range) return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    const [, s, e] = range.match(/^bytes=(\d+)-(\d+)$/);
    const from = Number(s);
    const to = Math.min(Number(e), bytes.length - 1);
    if (from >= bytes.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
    let body = bytes.subarray(from, to + 1);
    let cr = `bytes ${from}-${to}/${bytes.length}`;
    if (fault?.type === "truncate") body = body.subarray(0, Math.max(0, body.length - 1));
    if (fault?.type === "badRange") cr = `bytes ${from + 1}-${to + 1}/${bytes.length}`;
    return new Response(Buffer.from(body), { status: 206, headers: { "content-range": cr, "accept-ranges": "bytes" } });
  }

  async function http(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const kind = url.origin === UPLOADS ? "upload" : url.origin === SIGNED ? "signedRead" : url.origin === WEB ? "download" : "api";
    const fault = takeFault(kind);
    seen++;
    count("total");
    if (fault) {
      count("faulted");
      if (fault.type === 500 || fault.type === 502) return json(fault.type, { message: "server error" });
      if (fault.type === "drop") return Promise.reject(new TypeError("fetch failed: connection reset"));
      if (fault.type === "rate403" || fault.type === "rate429") return rateReply(fault.type);
    }
    if (kind === "upload") return upload(url, init, fault);
    if (kind === "signedRead") return signed(url, init, fault);
    if (kind === "download") return web(url);
    return api(method, url, init, fault);
  }

  return {
    http,
    counts,
    releases,
    clock,
    // Fail the request that is `offset` requests from now (0 = the next one).
    failAt(offset, type, kind) { faults.push({ at: seen + offset, type, kind }); },
    clearFaults() { faults.length = 0; },
    requestsSeen: () => seen,
    asset(name) {
      for (const rel of releases) for (const a of rel.assets) if (a.name === name) return { tag: rel.tag_name, ...a };
      return null;
    },
    assetCount: (name) => releases.reduce((s, r) => s + r.assets.filter((a) => a.name === name).length, 0),
    release: (tag) => releases.find((r) => r.tag_name === tag) ?? null,
    // Test setup without requests: a release holding `n` one-byte assets named by `nameOf(i)`.
    seed(tag, n, nameOf) {
      let rel = releases.find((r) => r.tag_name === tag);
      if (!rel) releases.push((rel = { id: nextId++, tag_name: tag, name: tag, prerelease: true, assets: [] }));
      for (let i = 0; i < n; i++) rel.assets.push({ id: nextId++, name: nameOf(i), bytes: Buffer.from([i & 0xff]), state: "uploaded", createdAt: new Date(clock.t).toISOString() });
    },
  };
}

export const FAULT_TYPES = [500, 502, "drop", "rate403", "rate429"];
