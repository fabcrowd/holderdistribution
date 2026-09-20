import { type ReactNode } from "react";
import { Lock } from "lucide-react";
import { useUserRole } from "@/hooks/useUserRole";
import { ForensicsUnlockGate, useForensicsUnlock } from "@/components/ForensicsGate";

type SubscriptionGateProps = {
  title?: string;
  description: string;
  minHeightClass?: string;
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
  children,
}: SubscriptionGateProps) => {
  const { isAdmin, isLoading, authLoading } = useUserRole();
  const { password, status, unlock } = useForensicsUnlock();

  if (authLoading || isLoading || status === "checking") {
    return <p className="text-xs text-muted-foreground">Checking access…</p>;
  }

  if (isAdmin || password !== null) return <>{children}</>;

  return (
    <div className={`relative rounded-lg border border-border/60 overflow-hidden ${minHeightClass}`}>
      <div className="select-none pointer-events-none blur-sm opacity-60" aria-hidden>
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-[2px] p-4 text-center">
        <Lock className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground max-w-[20rem]">{description}</p>
        <div className="w-full max-w-md">
          <ForensicsUnlockGate status={status} onUnlock={unlock} />
        </div>
      </div>
    </div>
  );
};
