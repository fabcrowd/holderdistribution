#!/usr/bin/env node
/**
 * probe-log-ranges.js — measure the widest eth_getLogs block range each RPC
 * endpoint accepts for a real token's Transfer topic, plus latency, the error
 * text at the limit and rate-limit behaviour. Feeds config/public-rpc-limits.json
 * and the getLogs bisection tests (scripts/lib/logRangeLimits.test.js).
 *
 *   node scripts/probe-log-ranges.js [--chain ethereum,polygon,base] [--include-keys] [--max-cu 5000] [--json out.json]
 *
 * Default: keyless public endpoints only (rpc.js getPublicFallbackUrls), 0 CU.
 * --include-keys also probes <PREFIX>_RPC_n keys from the environment (never
 * printed; shown as host + "#key<n>") and stops when the estimated Alchemy CU
 * spend (60 CU per eth_getLogs, 10 per eth_blockNumber, per Alchemy docs)
 * would pass --max-cu. Ranges tried: 10, 100, 500, 1000, 2000, 5000, 10000,
 * 100000 (ascending, stopping at the first rejection), ending at head.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getAllRpcUrls, getPublicFallbackUrls } from "./lib/rpc.js";

export const RANGES = [10, 100, 500, 1000, 2000, 5000, 10000, 100000];
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Busiest token per chain among the registered projects (ONDO on ethereum, TEL v3 on polygon/base).
export const PROBE_TOKENS = {
  ethereum: { symbol: "ONDO", address: "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3" },
  polygon: { symbol: "TEL", address: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32" },
  base: { symbol: "TEL", address: "0x09be1692ca16e06f536f0038ff11d1da8524adb1" },
};
const CU = { eth_getLogs: 60, eth_blockNumber: 10 };
const isAlchemy = (u) => /alchemy\.com|alchemyapi\.io/i.test(u);
const label = (u, i, keyed) => `${new URL(u).host}${keyed ? `#key${i}` : ""}`;

async function post(url, method, params, timeoutMs = 30000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* HTML error page */
    }
    return { ms: Date.now() - t0, status: r.status, retryAfter: r.headers.get("retry-after"), body, text: body ? null : text.slice(0, 120) };
  } catch (err) {
    return { ms: Date.now() - t0, status: 0, error: String(err?.name === "TimeoutError" ? `timeout ${timeoutMs}ms` : err?.message ?? err) };
  }
}

const errText = (r) => r.error ?? r.body?.error?.message ?? (r.status !== 200 ? `HTTP ${r.status} ${r.text ?? ""}`.trim() : null);

/** Probe one endpoint; returns { maxOk, firstReject, rejectMessage, samples[], cu }. */
export async function probeEndpoint(url, token, { ranges = RANGES, budget = { cu: Infinity }, post: call = post } = {}) {
  const res = { maxOk: null, firstReject: null, rejectMessage: null, samples: [], cu: 0 };
  const spend = (m) => {
    if (!isAlchemy(url)) return true;
    if (res.cu + CU[m] > budget.cu) return false;
    res.cu += CU[m];
    budget.cu -= CU[m];
    return true;
  };
  if (!spend("eth_blockNumber")) return { ...res, skipped: "CU budget" };
  const h = await call(url, "eth_blockNumber", []);
  const head = Number.parseInt(h.body?.result, 16);
  if (!Number.isFinite(head)) return { ...res, error: errText(h) ?? "no head" };
  for (const span of ranges) {
    if (!spend("eth_getLogs")) {
      res.stopped = "CU budget";
      break;
    }
    const r = await call(url, "eth_getLogs", [{ fromBlock: "0x" + (head - span + 1).toString(16), toBlock: "0x" + head.toString(16), address: token.address, topics: [TRANSFER_TOPIC] }]);
    const e = errText(r);
    res.samples.push({ span, ms: r.ms, status: r.status, logs: Array.isArray(r.body?.result) ? r.body.result.length : null, error: e?.slice(0, 160) ?? null, retryAfter: r.retryAfter ?? null });
    if (e) {
      res.firstReject = span;
      res.rejectMessage = e.slice(0, 160);
      break;
    }
    res.maxOk = span;
  }
  return res;
}

/** Fire `n` concurrent eth_blockNumber calls; count 429s / errors (rate-limit behaviour). */
export async function burst(url, n = 10, call = post) {
  const rs = await Promise.all(Array.from({ length: n }, () => call(url, "eth_blockNumber", [], 15000)));
  return { n, ok: rs.filter((r) => r.body?.result).length, http429: rs.filter((r) => r.status === 429).length, other: rs.filter((r) => !r.body?.result && r.status !== 429).map((r) => errText(r)?.slice(0, 60)), maxMs: Math.max(...rs.map((r) => r.ms)) };
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const chains = (arg("--chain") ?? "ethereum,polygon,base").split(",");
  const budget = { cu: Number(arg("--max-cu") ?? 5000) };
  const out = [];
  for (const chain of chains) {
    const token = PROBE_TOKENS[chain];
    const targets = getPublicFallbackUrls(chain).map((u, i) => ({ url: u, name: label(u, i, false), kind: "public" }));
    if (argv.includes("--include-keys")) getAllRpcUrls(chain).forEach((u, i) => targets.push({ url: u, name: label(u, i, true), kind: isAlchemy(u) ? "alchemy" : "keyed" }));
    for (const t of targets) {
      const p = await probeEndpoint(t.url, token, { budget });
      const b = t.kind === "public" && !argv.includes("--no-burst") ? await burst(t.url) : null;
      const row = { chain, endpoint: t.name, kind: t.kind, token: token.symbol, ...p, burst: b };
      out.push(row);
      console.log(`${chain.padEnd(8)} ${t.name.padEnd(34)} maxOk=${String(p.maxOk).padStart(6)} reject@${String(p.firstReject ?? "-").padStart(6)} cu=${p.cu} ${p.rejectMessage ? `"${p.rejectMessage.slice(0, 90)}"` : p.error ?? ""}${b ? ` burst10: ok=${b.ok} 429=${b.http429} maxMs=${b.maxMs}` : ""}`);
    }
  }
  const spent = out.reduce((a, r) => a + r.cu, 0);
  console.log(`Alchemy CU spent (est.): ${spent}`);
  if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify({ probedAt: new Date().toISOString(), rows: out, alchemyCu: spent }, null, 2));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => (console.error(e), process.exit(1)));
