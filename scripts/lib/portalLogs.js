// SQD Portal log source for historical backfills. Emits RPC-shaped logs (eth_getLogs output)
// so downstream code such as toTransfers can consume them unchanged.

const PORTAL_BASE_URL = "https://portal.sqd.dev/datasets";
const CHAIN_DATASETS = Object.freeze({
  ethereum: "ethereum-mainnet",
  polygon: "polygon-mainnet",
  base: "base-mainnet",
});
const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 2000;
// Portal filters support topic0..topic3 only.
const MAX_TOPIC_POSITIONS = 4;
const ERROR_SNIPPET_CHARS = 200;
const REQUIRED_LOG_FIELDS = ["address", "topics", "data", "transactionHash", "logIndex", "transactionIndex"];
const RESPONSE_FIELDS = {
  block: { number: true, hash: true, timestamp: true },
  log: { address: true, topics: true, data: true, transactionHash: true, logIndex: true, transactionIndex: true },
};

const ATTEMPT_STOP = "stop";
const ATTEMPT_RETRY = "retry";
const ATTEMPT_ENDED = "ended";

export class PortalError extends Error {
  constructor(message, { status, attempts } = {}) {
    super(message);
    this.name = "PortalError";
    this.status = status;
    this.attempts = attempts;
  }
}

export class PortalReorgError extends Error {
  constructor(message, { previousBlocks = [] } = {}) {
    super(message);
    this.name = "PortalReorgError";
    this.previousBlocks = previousBlocks;
  }
}

export function chainToDataset(chainKey) {
  if (!Object.hasOwn(CHAIN_DATASETS, chainKey)) {
    throw new PortalError(`No Portal dataset for chain "${chainKey}"`);
  }
  return CHAIN_DATASETS[chainKey];
}

const toHex = (n) => "0x" + Number(n).toString(16);

function missingLogFields(line, log) {
  const header = line?.header;
  const missing = [];
  if (!Number.isInteger(header?.number)) missing.push("header.number");
  if (typeof header?.hash !== "string") missing.push("header.hash");
  if (!Number.isInteger(header?.timestamp)) missing.push("header.timestamp");
  for (const field of REQUIRED_LOG_FIELDS) {
    if (log?.[field] == null) missing.push(`log.${field}`);
  }
  if (log?.topics != null && !Array.isArray(log.topics)) missing.push("log.topics (not an array)");
  return missing;
}

// Pure: `line` is one Portal JSONL block, `log` one entry of its `logs` array.
export function mapPortalLog(line, log) {
  const missing = missingLogFields(line, log);
  if (missing.length > 0) {
    throw new PortalError(`Portal log missing field(s): ${missing.join(", ")}`);
  }
  return {
    address: String(log.address).toLowerCase(),
    topics: log.topics,
    data: log.data,
    transactionHash: String(log.transactionHash).toLowerCase(),
    blockNumber: toHex(line.header.number),
    blockHash: line.header.hash,
    blockTimestamp: toHex(line.header.timestamp),
    transactionIndex: toHex(log.transactionIndex),
    logIndex: toHex(log.logIndex),
    removed: false,
  };
}

const lowerAll = (values) => [].concat(values).map((v) => String(v).toLowerCase());

function buildLogFilter({ address, topics, topic0 }) {
  const filter = {};
  if (address != null) filter.address = lowerAll(address);
  const positions = topics ?? (topic0 != null ? [topic0] : []);
  positions.slice(0, MAX_TOPIC_POSITIONS).forEach((value, index) => {
    if (value != null) filter[`topic${index}`] = lowerAll(value);
  });
  return filter;
}

function buildRequestBody(filter, fromBlock, toBlock) {
  return { type: "evm", fromBlock, toBlock, logs: [filter], fields: RESPONSE_FIELDS };
}

function createConfig(opts) {
  const apiKey = opts.apiKey ?? process.env.SQD_PORTAL_API_KEY;
  const datasetUrl = `${PORTAL_BASE_URL}/${opts.dataset}`;
  const authHeaders = apiKey ? { "x-api-key": apiKey } : {};
  return {
    dataset: opts.dataset,
    toBlock: opts.toBlock,
    filter: buildLogFilter(opts),
    streamUrl: `${datasetUrl}/stream`,
    heightUrl: `${datasetUrl}/height`,
    headers: { "content-type": "application/json", ...authHeaders },
    authHeaders,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    maxAttempts: opts.maxAttempts ?? MAX_ATTEMPTS,
    onRequest: opts.onRequest,
    baseDelayMs: opts.baseDelayMs ?? BASE_DELAY_MS,
  };
}

const isRetryableStatus = (status) => status === 429 || status >= 500;

async function readTextSafe(res) {
  try {
    return await res.text();
  } catch {
    // The status code is what drives the error; an unreadable body adds nothing.
    return "";
  }
}

async function httpError(cfg, res) {
  const snippet = (await readTextSafe(res)).slice(0, ERROR_SNIPPET_CHARS);
  return new PortalError(`Portal ${cfg.dataset} responded ${res.status}: ${snippet}`, { status: res.status });
}

async function reorgError(cfg, res) {
  let previousBlocks = [];
  try {
    previousBlocks = JSON.parse(await readTextSafe(res)).previousBlocks ?? [];
  } catch {
    // Keep the typed error even when the payload is not JSON; callers get an empty list.
  }
  return new PortalReorgError(`Portal ${cfg.dataset} reported a parent hash mismatch (409)`, { previousBlocks });
}

async function fetchHead(cfg) {
  const res = await cfg.fetchImpl(cfg.heightUrl, { headers: cfg.authHeaders });
  const head = Number.parseInt(await readTextSafe(res), 10);
  if (!res.ok || !Number.isInteger(head)) {
    throw new PortalError(`Portal ${cfg.dataset} height lookup failed`, { status: res.status });
  }
  return head;
}

// 204 means fromBlock is above the dataset head. Only a head below toBlock explains it;
// otherwise the function returns what it has, and the caller's completeness gate decides.
async function handleNoContent(cfg, st) {
  if (st.lastBlock >= cfg.toBlock) return ATTEMPT_STOP;
  const head = await fetchHead(cfg);
  if (head < cfg.toBlock) {
    throw new PortalError(`Portal ${cfg.dataset} head ${head} is below toBlock ${cfg.toBlock}`, { status: 204 });
  }
  return ATTEMPT_STOP;
}

function acceptBlock(cfg, st, block) {
  const number = block?.header?.number;
  if (!Number.isInteger(number)) throw new PortalError("Portal block line has no header.number");
  if (number <= st.lastBlock || number > cfg.toBlock) return;
  for (const log of block.logs ?? []) st.logs.push(mapPortalLog(block, log));
  st.lastBlock = number;
}

function acceptLine(cfg, st, line) {
  if (!line.trim()) return;
  let block;
  try {
    block = JSON.parse(line);
  } catch {
    throw new PortalError("Portal returned a malformed JSON line mid-stream");
  }
  acceptBlock(cfg, st, block);
}

// The last line can be cut off when the stream drops; discard it and let the resume refetch that block.
function acceptTail(cfg, st, tail) {
  if (!tail.trim()) return;
  let block;
  try {
    block = JSON.parse(tail);
  } catch {
    return;
  }
  if (Number.isInteger(block?.header?.number)) acceptBlock(cfg, st, block);
}

async function consumeStream(cfg, st, res) {
  if (!res.body) return ATTEMPT_ENDED;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      st.lastStatus = "stream";
      return ATTEMPT_RETRY;
    }
    if (chunk.done) break;
    const lines = (pending + decoder.decode(chunk.value, { stream: true })).split("\n");
    pending = lines.pop();
    for (const line of lines) acceptLine(cfg, st, line);
  }
  acceptTail(cfg, st, pending + decoder.decode());
  return ATTEMPT_ENDED;
}

async function handleResponse(cfg, st, res) {
  if (res.status === 204) return handleNoContent(cfg, st);
  if (res.status === 409) throw await reorgError(cfg, res);
  if (isRetryableStatus(res.status)) {
    st.lastStatus = res.status;
    try {
      await res.body?.cancel();
    } catch {
      // Connection already closed; nothing left to release.
    }
    return ATTEMPT_RETRY;
  }
  if (!res.ok) throw await httpError(cfg, res);
  return consumeStream(cfg, st, res);
}

async function runAttempt(cfg, st) {
  const body = buildRequestBody(cfg.filter, st.lastBlock + 1, cfg.toBlock);
  // Outside the try: a caller's cap or guard must abort the stream, not count as a retryable network error.
  cfg.onRequest?.();
  let res;
  try {
    res = await cfg.fetchImpl(cfg.streamUrl, { method: "POST", headers: cfg.headers, body: JSON.stringify(body) });
  } catch {
    st.lastStatus = "network";
    return ATTEMPT_RETRY;
  }
  return handleResponse(cfg, st, res);
}

// Loops until toBlock is reached. A stream that ends early is a resume, not completion.
// The failure counter resets on any progress, so only consecutive no-progress attempts count.
export async function streamLogs(opts) {
  const cfg = createConfig(opts);
  const st = { lastBlock: opts.fromBlock - 1, logs: [], lastStatus: undefined };
  let failures = 0;
  while (st.lastBlock < cfg.toBlock) {
    const before = st.lastBlock;
    const outcome = await runAttempt(cfg, st);
    if (outcome === ATTEMPT_STOP) break;
    if (st.lastBlock > before) {
      failures = 0;
      continue;
    }
    failures += 1;
    if (failures >= cfg.maxAttempts) {
      throw new PortalError(
        `Portal ${cfg.dataset} made no progress after ${failures} attempts (last: ${st.lastStatus ?? "none"})`,
        { status: typeof st.lastStatus === "number" ? st.lastStatus : undefined, attempts: failures },
      );
    }
    await cfg.sleep(cfg.baseDelayMs * 2 ** (failures - 1));
  }
  return st.logs;
}
