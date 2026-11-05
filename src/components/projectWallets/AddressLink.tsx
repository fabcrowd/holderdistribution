import { CopyButton } from "@/components/CopyButton";
import { useProject } from "@/hooks/useProject";
import { chainExplorerLink, type ExplorerChain } from "@/lib/explorerLinks";

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Find the project's chain by key (falls back to a bare key: Etherscan-style links need an explorer root). */
const useChain = (key: string): ExplorerChain | null => {
  const { project } = useProject();
  return (project.chains ?? []).find((c) => c.key === key) ?? null;
};

/** Address (label first when known) linked to the chain's explorer, with copy. */
export const AddressLink = ({ chain, address, label }: { chain: string; address: string; label?: string | null }) => {
  const c = useChain(chain);
  const href = c ? chainExplorerLink(c, "address", address) : null;
  const text = label || short(address);
  return (
    <span className="inline-flex items-center gap-1">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" title={address}>
          {text}
        </a>
      ) : (
        <span title={address}>{text}</span>
      )}
      <CopyButton value={address} label={`address ${address}`} />
    </span>
  );
};

/** Transaction hash linked to the explorer. */
export const TxLink = ({ chain, hash }: { chain: string; hash: string }) => {
  const c = useChain(chain);
  const href = c ? chainExplorerLink(c, "tx", hash) : null;
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-primary hover:underline" title={hash}>
      {short(hash)}
    </a>
  ) : (
    <span className="font-mono text-xs" title={hash}>{short(hash)}</span>
  );
};
