import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearLocalUnlock,
  persistLocalUnlock,
  readLocalUnlock,
  readValidLocalUnlock,
} from "@/lib/localUnlock";
import { verifyForensicsPassword } from "@/lib/forensicsGateApi";

/**
 * One shared unlock for every gated Supply surface (Reconciliation ledger,
 * History chart, Breakdown drill-downs, etc.). Wrap the Supply panel once.
 */
export type ForensicsUnlockStatus = "idle" | "checking" | "unlocked" | "error";

export type ForensicsUnlockContextValue = {
  password: string | null;
  status: ForensicsUnlockStatus;
  unlock: (candidate: string) => Promise<boolean>;
  lock: () => void;
};

const ForensicsUnlockContext = createContext<ForensicsUnlockContextValue | null>(null);

const failUnlock = (): false => {
  clearLocalUnlock();
  return false;
};

function useForensicsUnlockState(): ForensicsUnlockContextValue {
  const [password, setPassword] = useState<string | null>(null);
  const [status, setStatus] = useState<ForensicsUnlockStatus>(() =>
    readLocalUnlock() ? "checking" : "idle",
  );

  const tryUnlock = useCallback(async (candidate: string) => {
    setStatus("checking");
    try {
      if (!(await verifyForensicsPassword(candidate))) {
        setPassword(null);
        setStatus("error");
        return failUnlock();
      }
      setPassword(candidate);
      setStatus("unlocked");
      persistLocalUnlock(candidate);
      return true;
    } catch {
      setPassword(null);
      setStatus("error");
      return failUnlock();
    }
  }, []);

  const lock = useCallback(() => {
    clearLocalUnlock();
    setPassword(null);
    setStatus("idle");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const stored = readValidLocalUnlock();
      if (cancelled) return;
      if (stored) {
        await tryUnlock(stored);
        return;
      }
      setStatus((current) => (current === "checking" ? "idle" : current));
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [tryUnlock]);

  return { password, status, unlock: tryUnlock, lock };
}

export const ForensicsUnlockProvider = ({ children }: { children: ReactNode }) => {
  const value = useForensicsUnlockState();
  return (
    <ForensicsUnlockContext.Provider value={value}>{children}</ForensicsUnlockContext.Provider>
  );
};

export const useForensicsUnlock = (): ForensicsUnlockContextValue => {
  const ctx = useContext(ForensicsUnlockContext);
  if (!ctx) {
    throw new Error("useForensicsUnlock must be used within ForensicsUnlockProvider");
  }
  return ctx;
};

/** Inline password prompt shown above locked forensic content. */
export const ForensicsUnlockGate = ({
  status,
  onUnlock,
}: {
  status: ForensicsUnlockStatus;
  onUnlock: (candidate: string) => Promise<boolean>;
}) => {
  const [value, setValue] = useState("");
  const checking = status === "checking";

  const submit = () => {
    if (!value.trim()) return;
    void onUnlock(value);
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-2">
      <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Enter password for full details"
        className="h-11 flex-1 min-w-0 text-xs"
      />
      <Button size="sm" variant="secondary" className="h-11 px-2.5 text-xs shrink-0" onClick={submit} disabled={checking}>
        {checking ? "Checking…" : "Unlock"}
      </Button>
      {status === "error" && (
        <span className="text-[10px] text-destructive shrink-0">Could not unlock. Try again.</span>
      )}
    </div>
  );
};
