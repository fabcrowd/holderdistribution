import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearLocalUnlock,
  clearSessionToken,
  persistSessionToken,
  purgeLegacyUnlock,
  readSessionToken,
} from "@/lib/localUnlock";
import { checkSession, unlockWithPassword } from "@/lib/forensicsGateApi";
import { describeGateFailure, formatWait, gateErrorMessage, type ForensicsUnlockError } from "@/lib/gateErrors";

export type { ForensicsUnlockError };

/**
 * One shared unlock for every gated Supply surface (Reconciliation ledger,
 * History chart, Breakdown drill-downs, etc.). Wrap the Supply panel once.
 */
export type ForensicsUnlockStatus = "idle" | "checking" | "unlocked" | "error";


export type ForensicsUnlockContextValue = {
  /**
   * The credential gated fetches send: a signed session token from the gate
   * (or, when the server issues none, the password held in memory for this tab
   * only). Named `password` for the existing call sites.
   */
  password: string | null;
  status: ForensicsUnlockStatus;
  error?: ForensicsUnlockError | null;
  unlock: (candidate: string) => Promise<boolean>;
  lock: () => void;
  /** One password form on screen (the one marked `primary`); every other
   *  gate under this provider points to it instead of repeating the form. */
  singleGate?: boolean;
};

const ForensicsUnlockContext = createContext<ForensicsUnlockContextValue | null>(null);


function useForensicsUnlockState(): ForensicsUnlockContextValue {
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<ForensicsUnlockError | null>(null);
  const [status, setStatus] = useState<ForensicsUnlockStatus>(() => (readSessionToken() ? "checking" : "idle"));

  const fail = useCallback((e: ForensicsUnlockError) => {
    clearSessionToken();
    setPassword(null);
    setError(e);
    setStatus("error");
    return false as const;
  }, []);

  const tryUnlock = useCallback(
    async (candidate: string) => {
      setStatus("checking");
      setError(null);
      try {
        const result = await unlockWithPassword(candidate);
        if (!result) return fail({ kind: "invalid" });
        setPassword(result.credential);
        setStatus("unlocked");
        // Only a signed token is ever remembered; a bare password stays in memory.
        persistSessionToken(result.credential, result.expiresAt);
        return true;
      } catch (e) {
        return fail(describeGateFailure(e));
      }
    },
    [fail],
  );

  const lock = useCallback(() => {
    clearLocalUnlock();
    setPassword(null);
    setError(null);
    setStatus("idle");
  }, []);

  useEffect(() => {
    // Older builds stored the plaintext password in localStorage. Delete it.
    purgeLegacyUnlock();
    let cancelled = false;
    const stored = readSessionToken();
    if (!stored) {
      setStatus((current) => (current === "checking" ? "idle" : current));
      return;
    }
    void checkSession(stored)
      .then((ok) => {
        if (cancelled) return;
        if (ok) {
          setPassword(stored);
          setStatus("unlocked");
        } else {
          fail({ kind: "expired" });
        }
      })
      .catch((e) => {
        if (!cancelled) fail(describeGateFailure(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fail]);

  return useMemo(() => ({ password, status, error, unlock: tryUnlock, lock }), [password, status, error, tryUnlock, lock]);
}

export const ForensicsUnlockProvider = ({
  children,
  singleGate = false,
}: {
  children: ReactNode;
  singleGate?: boolean;
}) => {
  const state = useForensicsUnlockState();
  const value = useMemo(() => ({ ...state, singleGate }), [state, singleGate]);
  return (
    <ForensicsUnlockContext.Provider value={value}>{children}</ForensicsUnlockContext.Provider>
  );
};

const focusPrimaryGate = () => {
  const input = document.querySelector<HTMLInputElement>("[data-forensics-primary] input");
  if (!input) return;
  input.scrollIntoView({ block: "nearest" });
  input.focus();
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
  primary = false,
  compact = false,
}: {
  status: ForensicsUnlockStatus;
  onUnlock: (candidate: string) => Promise<boolean>;
  label?: string;
  /** The one form that renders when the provider is in `singleGate` mode. */
  primary?: boolean;
  /** One-row form: visually hidden label, 36px controls. */
  compact?: boolean;
}) => {
  const ctx = useContext(ForensicsUnlockContext);
  if (ctx?.singleGate && !primary) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="forensics-gate-pointer">
        <Lock aria-hidden="true" className="h-3.5 w-3.5" />
        <span>Password protected.</span>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={focusPrimaryGate}>
          Enter password
        </Button>
      </div>
    );
  }
  return <GateForm status={status} error={ctx?.error ?? null} onUnlock={onUnlock} label={label} primary={primary} compact={compact} />;
};

/** Seconds left until `retryAt`, ticking once a second; 0 when not limited. */
const useCountdown = (retryAt: number | null): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retryAt) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [retryAt]);
  return retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
};



const GateForm = ({
  status,
  error,
  onUnlock,
  label,
  primary,
  compact,
}: {
  status: ForensicsUnlockStatus;
  error: ForensicsUnlockError | null;
  onUnlock: (candidate: string) => Promise<boolean>;
  label: string;
  primary: boolean;
  compact: boolean;
}) => {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const checking = status === "checking";
  const waitS = useCountdown(status === "error" && error?.kind === "rate-limited" ? error.retryAt : null);
  const limited = status === "error" && error?.kind === "rate-limited" && waitS > 0;
  const inputId = useId();
  const errorId = `${inputId}-error`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || checking || limited) return;
    void onUnlock(value);
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-1.5"
      data-testid="forensics-unlock-form"
      {...(primary ? { "data-forensics-primary": "" } : {})}
    >
      <label htmlFor={inputId} className={compact ? "sr-only" : "text-xs font-medium text-foreground"}>
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
            className={`${compact ? "h-9 pr-11" : "h-11 pr-12"} pl-9 text-sm`}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            className={`absolute ${compact ? "right-1 h-7 w-7" : "right-0 h-11 w-11"} top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button type="submit" className={`${compact ? "h-9" : "h-11"} px-4 shrink-0`} disabled={checking || limited || !value.trim()}>
          {checking ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
          {checking ? "Checking…" : limited ? `Wait ${formatWait(waitS)}` : "Unlock"}
        </Button>
      </div>
      {status === "error" && (
        <p
          id={errorId}
          role="alert"
          data-testid="forensics-gate-error"
          data-kind={error?.kind ?? "invalid"}
          className={error?.kind === "expired" ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
        >
          {gateErrorMessage(error, waitS)}
        </p>
      )}
    </form>
  );
};
