import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
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

/**
 * Password prompt shown in place of locked forensic content.
 *
 * A real <form> (Enter and the button share one submit path, and password
 * managers recognise it), a programmatic label, a show/hide toggle for typing
 * on a phone, and an error that is announced (role="alert") and tied to the
 * input via aria-describedby instead of a 10px red fragment off to the side.
 */
export const ForensicsUnlockGate = ({
  status,
  onUnlock,
  label = "Password",
}: {
  status: ForensicsUnlockStatus;
  onUnlock: (candidate: string) => Promise<boolean>;
  label?: string;
}) => {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const checking = status === "checking";
  const inputId = useId();
  const errorId = `${inputId}-error`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || checking) return;
    void onUnlock(value);
  };

  return (
    <form onSubmit={submit} className="space-y-1.5" data-testid="forensics-unlock-form">
      <label htmlFor={inputId} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1 min-w-0">
          <Lock aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={inputId}
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Enter password"
            aria-invalid={status === "error"}
            aria-describedby={status === "error" ? errorId : undefined}
            className="h-11 pl-9 pr-11 text-sm"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button type="submit" className="h-11 px-4 shrink-0" disabled={checking || !value.trim()}>
          {checking ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
          {checking ? "Checking…" : "Unlock"}
        </Button>
      </div>
      {status === "error" && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          That password didn&apos;t work. Check it and try again. After 10 wrong attempts the gate pauses for 15 minutes.
        </p>
      )}
    </form>
  );
};
