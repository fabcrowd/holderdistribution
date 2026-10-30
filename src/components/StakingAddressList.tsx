import { ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { groupStakingAccounts, type StakingAddressLink } from "@/lib/stakingAddresses";

const shortAddress = (address: string) =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

const AccountAddress = ({ link }: { link: StakingAddressLink }) => (
  <span className="inline-flex items-center gap-0.5">
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      title={link.address}
      className="font-mono text-xs text-primary hover:underline sm:text-sm max-xl:inline-flex max-xl:min-h-11 max-xl:items-center max-xl:whitespace-nowrap max-xl:px-1"
    >
      {shortAddress(link.address)}
    </a>
    <CopyButton value={link.address} label={link.label} />
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${link.label} on Solscan`}
      title={link.address}
      className="inline-flex h-7 w-7 shrink-0 max-xl:h-11 max-xl:w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  </span>
);

/**
 * Program, lockup+vault pairs, and reward vaults. Staging (UAT) lockups are
 * omitted. Addresses are truncated; the full value is on hover and on copy.
 */
export const StakingAddressList = ({ links }: { links: StakingAddressLink[] }) => {
  const accounts = groupStakingAccounts(links);
  if (!accounts.program && accounts.lockups.length === 0 && accounts.rewardVaults.length === 0) return null;
  return (
    <div className="min-w-0 max-w-full space-y-4" data-testid="staking-address-list">
      {accounts.program ? (
        <div>
          <p className="mb-1 text-sm font-semibold text-foreground">Program</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-foreground">{accounts.program.label.replace(/\s*\(Solscan\)\s*$/i, "")}</span>
            <AccountAddress link={accounts.program} />
          </div>
        </div>
      ) : null}
      {accounts.lockups.length > 0 ? (
        <div>
          <p className="mb-1 text-sm font-semibold text-foreground">Lockups</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm max-sm:block" data-testid="staking-lockup-table">
              <thead className="max-sm:sr-only">
                <tr className="border-b border-border/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3 font-semibold">Lockup</th>
                  <th className="py-1.5 pr-3 font-semibold">Lockup account</th>
                  <th className="py-1.5 font-semibold">Vault ATA</th>
                </tr>
              </thead>
              <tbody className="max-sm:block">
                {accounts.lockups.map((row) => (
                  <tr key={row.lockup.href} className="border-b border-border/40 last:border-0 max-sm:block max-sm:py-2">
                    <th scope="row" className="py-1.5 pr-3 text-left text-sm font-medium text-foreground max-sm:block">
                      {row.name}
                    </th>
                    <td data-label="Account" className="py-1.5 pr-3 max-sm:flex max-sm:items-center max-sm:justify-between max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:uppercase max-sm:before:tracking-wide max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]">
                      <AccountAddress link={row.lockup} />
                    </td>
                    <td data-label="Vault ATA" className="py-1.5 max-sm:flex max-sm:items-center max-sm:justify-between max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:uppercase max-sm:before:tracking-wide max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]">{row.vault ? <AccountAddress link={row.vault} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {accounts.rewardVaults.length > 0 ? (
        <div>
          <p className="mb-0.5 text-sm font-semibold text-foreground">Reward vaults</p>
          <p className="mb-1 text-sm text-muted-foreground">Not staker principal — undistributed rewards.</p>
          <ul className="space-y-1">
            {accounts.rewardVaults.map((link) => (
              <li key={link.href} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-foreground">{link.label}</span>
                <AccountAddress link={link} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
