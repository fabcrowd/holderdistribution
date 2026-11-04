/**
 * Bot-cluster detection support (EVM and Solana alike): unlabelled wallets the
 * developer wallets keep funding with the token are candidates for a
 * botCluster entry in config/projects/<slug>/ledger.json. Candidates are
 * never counted as selling; a human confirms them (docs/LEDGER.md).
 */
export function detectBotCandidates(events, { minFundings = 3, minShare = 0.01, limit = 10 } = {}) {
  const out = events.filter((e) => e.direction === "out" && e.asset === "token" && !e.internal);
  const total = out.reduce((s, e) => s + (e.amount || 0), 0) || 1;
  const by = new Map();
  for (const e of out) {
    if (e.type !== "transfer_out" && e.type !== "bot_funding") continue;
    const k = `${e.chain}|${e.counterparty}`;
    const c = by.get(k) ?? { chain: e.chain, address: e.counterparty, label: e.counterpartyLabel ?? null, fundings: 0, amount: 0, funders: new Set(), firstTime: e.time, lastTime: e.time, sampleHashes: [] };
    c.fundings++;
    c.amount += e.amount || 0;
    c.funders.add(e.wallet);
    c.firstTime = Math.min(c.firstTime, e.time);
    c.lastTime = Math.max(c.lastTime, e.time);
    if (c.sampleHashes.length < 5) c.sampleHashes.push(e.hash);
    by.set(k, c);
  }
  return [...by.values()]
    .filter((c) => c.fundings >= minFundings && c.amount / total >= minShare)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
    .map((c) => ({ ...c, funders: [...c.funders], shareOfOutflow: Math.round((c.amount / total) * 1e4) / 1e4, reason: `Funded ${c.fundings} times by ${c.funders.size} developer wallet(s); review for a botCluster entry.` }));
}
