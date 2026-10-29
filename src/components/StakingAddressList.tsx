import { ExternalLink } from "lucide-react";
import type { StakingAddressKind, StakingAddressLink } from "@/lib/stakingAddresses";

const KIND_LABEL: Record<StakingAddressKind, string> = {
  program: "Staking program",
  lockup: "Lockup",
  "stake-vault": "Stake vault",
  "reward-vault": "Reward vault",
  other: "Contract",
};

/**
 * Explorer-linked staking accounts. The address is the link text so a reader
 * can check it without opening the methodology tip.
 */
export const StakingAddressList = ({
  links,
  kinds,
}: {
  links: StakingAddressLink[];
  kinds?: StakingAddressKind[];
}) => {
  const shown = kinds ? links.filter((link) => kinds.includes(link.kind)) : links;
  if (shown.length === 0) return null;
  return (
    <ul className="space-y-2" data-testid="staking-address-list">
      {shown.map((link) => (
        <li key={link.href} className="min-w-0">
          <div className="text-foreground">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{KIND_LABEL[link.kind]}</span>
            {link.kind === "reward-vault" ? (
              <span className="text-muted-foreground"> · not staker principal</span>
            ) : null}
            <span className="text-muted-foreground"> · {link.label}</span>
          </div>
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-start gap-1 break-all font-mono text-[11px] text-primary hover:underline"
          >
            {link.address}
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
};
