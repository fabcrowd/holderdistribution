/**
 * In-memory stand-in for the Hedera mirror node REST API, for tests only.
 * Mirrors the measured behaviour of mainnet-public.mirrornode.hedera.com:
 * limit capped at 100, `account.id` / `contract.id` range filters, a `next`
 * link only when a page is full, a snapshot `timestamp` on /balances (the
 * latest snapshot at or before the requested `timestamp`), and balances as raw
 * JSON integers that exceed 2^53.
 */
const idNum = (id) => Number(String(id).split(".")[2]);
const nanosOf = (stamp) => {
  const [s, f = ""] = String(stamp).replace(/^lte:/, "").split(".");
  return BigInt(s) * 1_000_000_000n + BigInt(f.padEnd(9, "0").slice(0, 9));
};

function applyFilters(values, num, params, name) {
  let ok = true;
  for (const raw of params.getAll(name)) {
    const [op, v] = raw.split(":");
    const n = idNum(v);
    if (op === "gt") ok &&= num > n;
    else if (op === "gte") ok &&= num >= n;
    else if (op === "lt") ok &&= num < n;
    else if (op === "lte") ok &&= num <= n;
    else throw new Error(`mock: unsupported ${name} operator ${op}`);
  }
  return ok;
}

export function createMockMirror({
  accounts = [], // { num, balance: bigint, tokens?: [{ token_id, balance }] }
  contracts = [], // numeric ids
  snapshotTimestamp = "1794165040.107980111",
  headTimestamp = "1794165294.000000001", // /balances without a timestamp reports "now", not a snapshot
  totalSupply = null, // default: the sum of every balance, as on mainnet where no HBAR is burned
  releasedSupply = "4432714701836802108",
  blockCount = 1000,
  blockTime = (n) => 1_568_332_800 + n * 2,
  clusters = null, // { <id>: [sorted "seconds.nanos" stamps] }; each cluster answers a pinned timestamp with its latest stamp at or before it
  route = () => null, // (callIndex) => cluster id that answers this call (default: the first cluster)
  tamper = null, // (path, params, body) => body | undefined; edits a parsed /balances or /contracts response
  notFound = () => false, // (path, query, callIndex, cluster) => true answers HTTP 404 (a cluster that lacks the pinned stamp)
  fail = () => null, // (path, query, callIndex) => status code | "network" | null
} = {}) {
  const sorted = [...accounts].sort((a, b) => a.num - b.num);
  const supplyText = totalSupply ?? String(sorted.reduce((sum, a) => sum + a.balance, 0n));
  const calls = [];
  const snapTs = () => (typeof snapshotTimestamp === "function" ? snapshotTimestamp(calls.length) : snapshotTimestamp);
  const respond = (status, body, clusterId = null) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "x-cluster-id" ? clusterId : null) },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  function stampFor(requested, cluster) {
    if (!clusters) return snapTs();
    const at = nanosOf(requested);
    return [...(clusters[cluster] ?? [])].reverse().find((t) => nanosOf(t) <= at) ?? null;
  }

  function balances(params, cluster) {
    const limit = Math.min(Number(params.get("limit") ?? 25), 100);
    const floor = params.get("account.balance") ? BigInt(params.get("account.balance").split(":")[1]) : null;
    const order = params.get("order") ?? "asc";
    let rows = sorted.filter((a) => applyFilters(null, a.num, params, "account.id"));
    if (floor !== null) rows = rows.filter((a) => a.balance >= floor);
    if (order === "desc") rows = [...rows].reverse();
    const stampOfRequest = params.get("timestamp") ? stampFor(params.get("timestamp"), cluster) : null;
    const page = clusters && params.get("timestamp") && stampOfRequest === null ? [] : rows.slice(0, limit);
    const text = page
      .map((a) => `{"account":"0.0.${a.num}","balance":${a.balance},"tokens":${JSON.stringify(a.tokens ?? [])}}`)
      .join(",");
    const next = page.length === limit ? `"/api/v1/balances?next"` : "null";
    const stamp = page.length === 0 ? null : params.get("timestamp") ? stampOfRequest : headTimestamp; // real mirror: null on an empty page
    return `{"timestamp":${stamp === null ? "null" : `"${stamp}"`},"balances":[${text}],"links":{"next":${next}}}`;
  }

  function contractList(params) {
    const limit = Math.min(Number(params.get("limit") ?? 25), 100);
    const rows = [...contracts].sort((a, b) => a - b).filter((n) => applyFilters(null, n, params, "contract.id"));
    const page = rows.slice(0, limit).map((n) => ({ contract_id: `0.0.${n}`, deleted: false }));
    return { contracts: page, links: { next: page.length === limit ? "/api/v1/contracts?next" : null } };
  }

  const block = (n) => ({ number: n, timestamp: { from: blockTime(n).toFixed(9), to: blockTime(n + 1).toFixed(9) } });

  async function fetch(url) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const query = u.search;
    const index = calls.length;
    const cluster = clusters ? (route(index) ?? Object.keys(clusters)[0]) : null;
    calls.push({ path, query, params: u.searchParams, cluster });
    const injected = fail(path, query, index);
    if (injected === "network") throw new TypeError("fetch failed");
    if (injected) return respond(injected, `{"_status":{"messages":[{"message":"injected ${injected}"}]}}`);
    if (notFound(path, query, index, cluster)) return respond(404, { _status: { messages: [{ message: "Not found" }] } }, cluster ?? "mock");
    if (path === "/balances" || path === "/contracts") {
      const raw = path === "/balances" ? balances(u.searchParams, cluster) : contractList(u.searchParams);
      const edited = tamper ? tamper(path, u.searchParams, JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw))) : undefined;
      return respond(200, edited === undefined ? raw : JSON.stringify(edited), cluster === "unknown" ? null : (cluster ?? "mock")); // cluster "unknown" sends no x-cluster-id
    }
    if (path === "/network/supply") {
      const at = u.searchParams.get("timestamp");
      return respond(200, `{"released_supply":${releasedSupply},"timestamp":"${at ?? snapTs()}","total_supply":${supplyText}}`);
    }
    if (path === "/blocks") {
      const params = u.searchParams;
      const ts = params.get("timestamp");
      if (ts) {
        const t = Number(ts.split(":")[1]);
        let n = Math.floor((t - blockTime(0)) / 2);
        n = Math.max(0, Math.min(blockCount - 1, n));
        return respond(200, { blocks: n >= 0 ? [block(n)] : [], links: { next: null } });
      }
      return respond(200, { blocks: [block(blockCount - 1)], links: { next: null } });
    }
    const m = /^\/blocks\/(\d+)$/.exec(path);
    if (m) {
      const n = Number(m[1]);
      return n < blockCount ? respond(200, block(n)) : respond(404, { _status: { messages: [{ message: "Not found" }] } });
    }
    return respond(404, { _status: { messages: [{ message: `mock: no route ${path}` }] } });
  }

  return { fetch, calls, balanceCalls: () => calls.filter((c) => c.path === "/balances") };
}
