import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AddressLink, TxLink } from "@/components/projectWallets/AddressLink";
import { useProject } from "@/hooks/useProject";
import { chainExplorerLink } from "@/lib/explorerLinks";
import type { Claim, ClaimSeg, TxFilter, TxRef } from "@/lib/ledgerClaims";

const linkCls = "text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid";

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** "[n tx]" proof popover: top hashes on the explorer + "see all". */
export const ProofPopover = ({ txs, count, onSeeAll }: { txs: TxRef[]; count: number; onSeeAll?: () => void }) => (
  <Popover>
    <PopoverTrigger asChild>
      <button type="button" className="ml-0.5 align-super text-xs font-semibold text-primary hover:underline" aria-label={`View proof: ${count} transactions`} data-testid="proof-trigger">[{count} tx]</button>
    </PopoverTrigger>
    <PopoverContent className="w-72 p-3 text-xs" data-testid="proof-popover">
      <p className="mb-1.5 font-semibold">View proof{txs.length < count ? ` (top ${txs.length} of ${count})` : ""}</p>
      {txs.length === 0 ? <p className="text-muted-foreground">No transaction hashes in this report.</p> : (
        <ul className="space-y-1">{txs.map((t) => <li key={t.hash} className="flex items-center justify-between gap-2"><TxLink chain={t.chain} hash={t.hash} /><span className="text-muted-foreground">{t.chain}</span></li>)}</ul>
      )}
      {onSeeAll && <button type="button" className="mt-2 font-semibold text-primary hover:underline" onClick={onSeeAll}>See all {count} →</button>}
    </PopoverContent>
  </Popover>
);

const SingleTx = ({ seg }: { seg: Extract<ClaimSeg, { kind: "tx" }> }) => {
  const { project } = useProject();
  const c = (project.chains ?? []).find((x) => x.key === seg.chain);
  const href = c ? chainExplorerLink(c, "tx", seg.hash) : null;
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className={linkCls} title={`${seg.hash} (${seg.chain})`} data-testid="claim-tx">{seg.text}</a> : <span title={seg.hash}>{seg.text}</span>;
};

const Seg = ({ seg, onFilter }: { seg: ClaimSeg; onFilter: (f: TxFilter) => void }) => {
  if (typeof seg === "string") return <>{seg}</>;
  if (seg.kind === "tx") return <SingleTx seg={seg} />;
  if (seg.kind === "address") return <span className="inline-flex items-baseline gap-1"><AddressLink chain={seg.chain} address={seg.address} label={seg.text} /><span className="text-xs uppercase text-muted-foreground">{seg.chain}</span></span>;
  if (seg.kind === "section") {
    return <><button type="button" className={linkCls} onClick={() => scrollTo(seg.target)} data-testid="claim-section">{seg.text}</button>{seg.txs.length > 0 && <ProofPopover txs={seg.txs} count={seg.count} onSeeAll={() => scrollTo(seg.target)} />}</>;
  }
  const go = () => onFilter(seg.filter);
  return <><button type="button" className={linkCls} onClick={go} data-testid="claim-filter">{seg.text}</button><ProofPopover txs={seg.txs} count={seg.count} onSeeAll={go} /></>;
};

export const SummaryClaims = ({ claims, onFilter }: { claims: Claim[]; onFilter: (f: TxFilter) => void }) => (
  <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="pw-headlines">
    {claims.map((c) => <li key={c.key}>{c.segs.map((s, i) => <Seg key={i} seg={s} onFilter={onFilter} />)}</li>)}
  </ul>
);
