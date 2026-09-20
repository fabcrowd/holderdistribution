export type PnlWallet = {
  address: string;
  name: string;
};

export type PnlEvent = {
  id: string;
  kind: "sell" | "tel_transfer" | string;
  chain: string;
  txHash: string;
  timestamp: number | null;
  fromWallet: string;
  fromName: string;
  to: string;
  toLabel: string | null;
  telAmount: number;
  classification: string;
  quoteAmount: number | null;
  quoteToken: string | null;
  proceedTo: string | null;
  proceedStatus: string | null;
  endpoint?: string | null;
  endpointChain?: string | null;
};

export type PnlTx = {
  id: string;
  chain: string;
  txHash: string;
  timestamp: number | null;
  to: string;
  toLabel: string | null;
  telAmount: number;
  usd: number | null;
  token: string | null;
};

export type GlLine = {
  code: string;
  name: string;
  side: "revenue" | "expense";
  tel: number;
  usd: number;
  txs: PnlTx[];
};

export type CostCenter = {
  address: string;
  name: string;
  telOut: number;
  usdProceeds: number;
  lines: GlLine[];
};

export type DispositionPnl = {
  costCenters: CostCenter[];
  totalTelOut: number;
  totalUsdProceeds: number;
};

export const isCostCenterWallet = (wallet: PnlWallet): boolean =>
  !wallet.name.toLowerCase().includes("reward contract");

const STABLE_QUOTE_TOKENS = new Set(["USDC", "USDC.e", "USDT", "USDT0"]);

const TRANSFER_GL: Record<string, { code: string; name: string }> = {
  dex_venue: { code: "5100", name: "TEL sold for stablecoin" },
  internal_safe: { code: "6100", name: "Sent to other Association wallets" },
  custody: { code: "6200", name: "Sent to custody / escrow" },
  bridge: { code: "6300", name: "Moved between blockchains" },
  infrastructure: { code: "6400", name: "Sent to infrastructure" },
  holdings: { code: "6500", name: "Sent to Telcoin Holdings" },
  cex: { code: "6600", name: "Sent to an exchange" },
  reward_contract: { code: "6700", name: "Sent to reward programs" },
  reward_payout: { code: "6710", name: "Paid to reward claimants" },
  burn: { code: "6750", name: "Burned" },
  unlabeled: { code: "6800", name: "Sent — destination not classified" },
};

const REVENUE = { code: "4000", name: "Stablecoin from TEL sales", side: "revenue" as const };
const TEL_SOLD = { code: "5100", name: "TEL sold for stablecoin", side: "expense" as const };
const OTHER_TRANSFER = { code: "6900", name: "Other TEL movements", side: "expense" as const };

const CLASSIFICATION_LABELS: Record<string, string> = {
  dex_venue: "Sold for stablecoin",
  internal_safe: "Other Association wallets",
  custody: "Custody / escrow",
  bridge: "Moved between blockchains",
  infrastructure: "Infrastructure",
  holdings: "Telcoin Holdings",
  cex: "Exchanges",
  reward_contract: "Reward programs",
  reward_payout: "Reward claimants",
  burn: "Burned",
  unlabeled: "Not yet classified",
};

export const classificationLabel = (cls: string): string =>
  CLASSIFICATION_LABELS[cls] ?? TRANSFER_GL[cls]?.name ?? cls.replace(/_/g, " ");

export const isStableQuoteToken = (token: string | null | undefined): boolean =>
  STABLE_QUOTE_TOKENS.has(token ?? "");

export const stableQuoteUsd = (token: string | null | undefined, amount: number | null | undefined): number =>
  amount != null && isStableQuoteToken(token) ? amount : 0;

export const explorerTx = (chain: string, hash: string): string =>
  chain === "polygon" ? `https://polygonscan.com/tx/${hash}` : `https://etherscan.io/tx/${hash}`;

export const explorerAddress = (chain: string, address: string): string => {
  if (chain === "polygon") return `https://polygonscan.com/address/${address}`;
  if (chain === "base") return `https://basescan.org/address/${address}`;
  return `https://etherscan.io/address/${address}`;
};

export const explorerChainForCenter = (center: CostCenter): string => {
  for (const line of center.lines) {
    const chain = line.txs.find((tx) => tx.chain)?.chain;
    if (chain) return chain;
  }
  return "polygon";
};

export type WhereTelWentDest = {
  to: string;
  toLabel: string | null;
  chain: string;
  tel: number;
  txCount: number;
};

export type WhereTelWentBucket = {
  cls: string;
  tel: number;
  txCount: number;
  destinations: WhereTelWentDest[];
};

export const buildWhereTelWent = (events: PnlEvent[]): WhereTelWentBucket[] => {
  const buckets = new Map<string, { tel: number; txCount: number; dests: Map<string, WhereTelWentDest> }>();
  for (const event of events) {
    if (!(event.telAmount > 0)) continue;
    const cls = event.classification || "unlabeled";
    if (cls === "chain_transport") continue;
    const to = (event.endpoint || event.to || "").toLowerCase();
    const chain = event.endpointChain || event.chain;
    const key = `${chain}:${to}`;
    let bucket = buckets.get(cls);
    if (!bucket) {
      bucket = { tel: 0, txCount: 0, dests: new Map() };
      buckets.set(cls, bucket);
    }
    bucket.tel += event.telAmount;
    bucket.txCount += 1;
    const dest = bucket.dests.get(key) ?? {
      to,
      toLabel: event.toLabel,
      chain,
      tel: 0,
      txCount: 0,
    };
    dest.tel += event.telAmount;
    dest.txCount += 1;
    if (!dest.toLabel && event.toLabel) dest.toLabel = event.toLabel;
    bucket.dests.set(key, dest);
  }
  return [...buckets.entries()]
    .map(([cls, bucket]) => ({
      cls,
      tel: bucket.tel,
      txCount: bucket.txCount,
      destinations: [...bucket.dests.values()].sort((a, b) => b.tel - a.tel),
    }))
    .sort((a, b) => b.tel - a.tel);
};

export type StablecoinSaleRow = {
  fromWallet: string;
  fromName: string;
  chain: string;
  quoteToken: string | null;
  quoteAmount: number | null;
  proceedTo: string | null;
  proceedChain: string | null;
  proceedToken: string | null;
  proceedStatus: string | null;
  proceedClassification: string | null;
};

export type WhereStablecoinWentDest = {
  to: string;
  toLabel: string | null;
  chain: string;
  usd: number;
  txCount: number;
  token: string | null;
};

export type WhereStablecoinWentBucket = {
  cls: string;
  usd: number;
  txCount: number;
  destinations: WhereStablecoinWentDest[];
};

const STABLECOIN_PROCEED_LABELS: Record<string, string> = {
  retained_in_wallet: "Still in selling wallet",
  in_wallet: "Still in selling wallet",
  unlabeled: "Paid to external wallet",
  cex: "Exchange deposit",
  payroll_processor: "Payroll / contractor hub",
  contractor: "Contractor / vendor",
  forwarder: "Forwarder chain",
};

export const stablecoinProceedLabel = (cls: string): string =>
  STABLECOIN_PROCEED_LABELS[cls] ?? cls.replace(/_/g, " ");

const stablecoinBucketCls = (sell: StablecoinSaleRow): string => {
  if (sell.proceedStatus === "retained_in_wallet") return "retained_in_wallet";
  return sell.proceedClassification?.trim() || "unlabeled";
};

/** Group TEL-sale stablecoin proceeds by disposition (retained vs paid out) and payee. */
export const buildWhereStablecoinWent = (sells: StablecoinSaleRow[]): WhereStablecoinWentBucket[] => {
  const buckets = new Map<
    string,
    { usd: number; txCount: number; dests: Map<string, WhereStablecoinWentDest> }
  >();

  for (const sell of sells) {
    const usd = stableQuoteUsd(sell.quoteToken, sell.quoteAmount);
    if (!(usd > 0)) continue;

    const cls = stablecoinBucketCls(sell);
    let bucket = buckets.get(cls);
    if (!bucket) {
      bucket = { usd: 0, txCount: 0, dests: new Map() };
      buckets.set(cls, bucket);
    }
    bucket.usd += usd;
    bucket.txCount += 1;

    const retained = cls === "retained_in_wallet";
    const to = (retained ? sell.fromWallet : sell.proceedTo ?? "").trim().toLowerCase();
    if (!to) continue;
    const chain = retained ? sell.chain : sell.proceedChain ?? sell.chain;
    const token = sell.proceedToken ?? sell.quoteToken;
    const destKey = `${chain}:${to}:${token ?? ""}`;
    const dest = bucket.dests.get(destKey) ?? {
      to,
      toLabel: retained ? sell.fromName : null,
      chain,
      usd: 0,
      txCount: 0,
      token,
    };
    dest.usd += usd;
    dest.txCount += 1;
    if (retained && !dest.toLabel) dest.toLabel = sell.fromName;
    bucket.dests.set(destKey, dest);
  }

  const order = ["retained_in_wallet", "unlabeled", "cex", "payroll_processor", "contractor", "forwarder"];
  return [...buckets.entries()]
    .map(([cls, bucket]) => ({
      cls,
      usd: bucket.usd,
      txCount: bucket.txCount,
      destinations: [...bucket.dests.values()].sort((a, b) => b.usd - a.usd),
    }))
    .sort((a, b) => {
      const ai = order.indexOf(a.cls);
      const bi = order.indexOf(b.cls);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return b.usd - a.usd;
    });
};

const glForTransfer = (classification: string): { code: string; name: string; side: "expense" } => {
  const mapped = TRANSFER_GL[classification];
  if (mapped) return { ...mapped, side: "expense" };
  return OTHER_TRANSFER;
};

const toTx = (event: PnlEvent, usd: number | null, token: string | null): PnlTx => ({
  id: event.id,
  chain: event.chain,
  txHash: event.txHash,
  timestamp: event.timestamp,
  to: event.proceedTo ?? event.to,
  toLabel: event.toLabel,
  telAmount: event.telAmount,
  usd,
  token,
});

const pushLine = (
  byCode: Map<string, GlLine>,
  meta: { code: string; name: string; side: "revenue" | "expense" },
  delta: { tel: number; usd: number },
  tx: PnlTx,
) => {
  const existing = byCode.get(meta.code);
  if (existing) {
    existing.tel += delta.tel;
    existing.usd += delta.usd;
    existing.txs.push(tx);
    return;
  }
  byCode.set(meta.code, {
    code: meta.code,
    name: meta.name,
    side: meta.side,
    tel: delta.tel,
    usd: delta.usd,
    txs: [tx],
  });
};

export const buildDispositionPnl = ({
  wallets,
  events,
}: {
  wallets: PnlWallet[];
  events: PnlEvent[];
}): DispositionPnl => {
  const centers = wallets.filter(isCostCenterWallet);
  const centerSet = new Set(centers.map((w) => w.address.toLowerCase()));
  const linesByWallet = new Map<string, Map<string, GlLine>>();
  for (const w of centers) linesByWallet.set(w.address.toLowerCase(), new Map());

  for (const event of events) {
    const from = event.fromWallet.toLowerCase();
    if (!centerSet.has(from)) continue;
    const byCode = linesByWallet.get(from);
    if (!byCode) continue;

    const isSell = event.kind === "sell";
    const hasQuote = stableQuoteUsd(event.quoteToken, event.quoteAmount) !== 0;
    if (!isSell && !(event.telAmount > 0) && !hasQuote) continue;
    if (!isSell && event.classification === "chain_transport") continue;

    if (isSell) {
      pushLine(byCode, TEL_SOLD, { tel: event.telAmount, usd: 0 }, toTx(event, event.quoteAmount, event.quoteToken));
      if (hasQuote) {
        pushLine(
          byCode,
          REVENUE,
          { tel: 0, usd: event.quoteAmount ?? 0 },
          toTx(event, event.quoteAmount, event.quoteToken),
        );
      }
      continue;
    }

    pushLine(byCode, glForTransfer(event.classification), { tel: event.telAmount, usd: 0 }, toTx(event, null, null));
  }

  const costCenters: CostCenter[] = centers.map((w) => {
    const lines = [...(linesByWallet.get(w.address.toLowerCase())?.values() ?? [])].sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    const telOut = lines.filter((l) => l.side === "expense").reduce((sum, l) => sum + l.tel, 0);
    const usdProceeds = lines.filter((l) => l.side === "revenue").reduce((sum, l) => sum + l.usd, 0);
    return { address: w.address, name: w.name, telOut, usdProceeds, lines };
  });

  costCenters.sort((a, b) => b.telOut - a.telOut || a.name.localeCompare(b.name));

  return {
    costCenters,
    totalTelOut: costCenters.reduce((sum, c) => sum + c.telOut, 0),
    totalUsdProceeds: costCenters.reduce((sum, c) => sum + c.usdProceeds, 0),
  };
};
