import { Link } from "react-router-dom";
import { ExternalLink, Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUserRole } from "@/hooks/useUserRole";
import { useWalletAnalysis, type WalletAnalysis } from "@/hooks/useWalletAnalysis";

const formatCompactTEL = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};

const shortAddr = (a: string) =>
  a.startsWith("0x") && a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const explorerUrl = (address: string) => `https://etherscan.io/address/${address}`;

type LockedAnalysisTileProps = {
  address: string;
  /**
   * Password from the Supply forensics gate, or null. Sent to the Netlify gate
   * with each load; admins use their Supabase session instead.
   */
  password?: string | null;
};

const AnalysisBody = ({ data }: { data: WalletAnalysis }) => (
  <div className="space-y-3 text-xs leading-relaxed">
    <div>
      <p className="font-semibold text-foreground text-sm">{data.title}</p>
      <p className="text-muted-foreground mt-1">{data.summary}</p>
    </div>
    <div>
      <p className="font-medium text-foreground mb-1">Funding chain</p>
      <ul className="space-y-1.5">
        {data.fundingChain.map((leg, i) => (
          <li key={`${leg.from}-${i}`} className="border-b border-border/40 pb-1.5 last:border-0">
            <div className="flex justify-between gap-2">
              <a
                href={explorerUrl(leg.from)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline truncate"
              >
                {shortAddr(leg.from)}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              <span className="tabular-nums shrink-0">{formatCompactTEL(leg.amountTel)}</span>
            </div>
            <div className="text-muted-foreground">
              {leg.date} — {leg.note}
            </div>
          </li>
        ))}
      </ul>
    </div>
    <div>
      <p className="font-medium text-foreground mb-1">Counterparties</p>
      <ul className="space-y-1">
        {data.counterparties.map((c, i) => (
          <li key={`${c.address}-${i}`} className="flex justify-between gap-2">
            <span className="truncate">
              <a
                href={explorerUrl(c.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {shortAddr(c.address)}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>{" "}
              <span className="text-muted-foreground">({c.role})</span>
            </span>
            <span className="tabular-nums shrink-0">{formatCompactTEL(c.amountTel)}</span>
          </li>
        ))}
      </ul>
    </div>
    {data.controllers.length > 0 && (
      <div>
        <p className="font-medium text-foreground mb-1">Controllers</p>
        <ul className="space-y-0.5 text-muted-foreground">
          {data.controllers.map((c, i) => (
            <li key={`${c}-${i}`}>
              <a
                href={explorerUrl(c)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {shortAddr(c)}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    )}
    <div>
      <p className="font-medium text-foreground mb-1">Classification</p>
      <p className="text-muted-foreground">
        <span className="text-foreground font-medium capitalize">{data.classification}</span>
        {" — "}
        {data.evidence}
      </p>
    </div>
  </div>
);

/**
 * Deep-dive analysis for a wallet. Unlocked after the Supply password gate,
 * or for a signed-in admin. Others see a blurred "Subscription Required" tile.
 */
const LockedAnalysisTile = ({ address, password = null }: LockedAnalysisTileProps) => {
  const { isAdmin, isAuthenticated, isLoading, authLoading } = useUserRole();
  const canAttempt = isAdmin || password !== null;
  const { data, isLoading: analysisLoading } = useWalletAnalysis(
    canAttempt ? address : null,
    password,
    isAdmin,
  );

  if (password === null && (authLoading || isLoading)) {
    return <p className="text-xs text-muted-foreground">Checking access…</p>;
  }

  if (canAttempt) {
    if (analysisLoading) {
      return <p className="text-xs text-muted-foreground">Loading analysis…</p>;
    }
    if (!data) {
      return <p className="text-xs text-muted-foreground">No analysis file for this wallet.</p>;
    }
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Unlock className="h-3.5 w-3.5" />
          Analysis unlocked
        </div>
        <AnalysisBody data={data} />
      </div>
    );
  }

  return (
    <div className="relative rounded-lg border border-border/60 overflow-hidden min-h-[10rem]">
      <div
        className="p-3 select-none pointer-events-none blur-sm opacity-60 space-y-2"
        aria-hidden
      >
        <p className="font-semibold text-sm">Funding chain · counterparties · controllers</p>
        <div className="h-2 w-3/4 bg-muted rounded" />
        <div className="h-2 w-1/2 bg-muted rounded" />
        <div className="h-16 bg-muted/80 rounded" />
        <div className="h-2 w-2/3 bg-muted rounded" />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 backdrop-blur-[2px] p-4 text-center">
        <Lock className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">Subscription Required</p>
        <p className="text-[11px] text-muted-foreground max-w-[16rem]">
          Deep funding-chain and controller analysis unlocks with an admin account.
        </p>
        {!isAuthenticated ? (
          <Button asChild size="sm" variant="secondary" className="mt-1">
            <Link to="/auth">Sign in</Link>
          </Button>
        ) : (
          <p className="text-[11px] text-muted-foreground">Signed in — admin role required.</p>
        )}
      </div>
    </div>
  );
};

export default LockedAnalysisTile;
