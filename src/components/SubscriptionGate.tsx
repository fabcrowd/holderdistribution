import { type ReactNode } from "react";
import { Lock } from "lucide-react";
import { useUserRole } from "@/hooks/useUserRole";
import { ForensicsUnlockGate, useForensicsUnlock } from "@/components/ForensicsGate";

type SubscriptionGateProps = {
  title?: string;
  description: string;
  minHeightClass?: string;
  /** Locked state as a single row (icon, copy, inline password form) instead
   *  of a blurred full-size preview — for the fixed-height desktop grid. */
  compact?: boolean;
  /** This gate carries the one password form under a `singleGate` provider. */
  primary?: boolean;
  children: ReactNode;
};


/**
 * Blurred lock overlay for gated Supply content. Admins and a successful
 * forensics password unlock (shared across all Supply tabs) see children.
 */
export const SubscriptionGate = ({
  title = "Password required",
  description,
  minHeightClass = "min-h-[10rem]",
  compact = false,
  primary = false,
  children,
}: SubscriptionGateProps) => {
  const { isAdmin, isLoading, authLoading } = useUserRole();
  const { password, status, unlock } = useForensicsUnlock();

  if (authLoading || isLoading || status === "checking") {
    return <p className="text-xs text-muted-foreground">Checking access…</p>;
  }

  if (isAdmin || password !== null) return <>{children}</>;

  if (compact) {
    return (
      <div className="flex h-full items-center gap-4" data-testid="gate-compact">
        <Lock aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="truncate text-[11px] text-muted-foreground" title={description}>{description}</p>
        </div>
        <div className="w-[22rem] shrink-0">
          <ForensicsUnlockGate status={status} onUnlock={unlock} primary={primary} compact />
        </div>
      </div>
    );
  }

  return (
    <div className={`relative rounded-lg border border-border/60 overflow-hidden ${minHeightClass}`}>
      {/* inert, not just aria-hidden: the blurred preview's own buttons must
          not be reachable by Tab either (axe aria-hidden-focus). */}
      <div className="select-none pointer-events-none blur-sm opacity-60" aria-hidden {...{ inert: "" }}>
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-[2px] p-4 text-center">
        <Lock className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground max-w-[20rem]">{description}</p>
        <div className="w-full max-w-md">
          <ForensicsUnlockGate status={status} onUnlock={unlock} primary={primary} />
        </div>
      </div>
    </div>
  );
};
