import { ForensicsGateError } from "@/lib/forensicsGateApi";

/** Why the last unlock failed, so the form can say something specific. */
export type ForensicsUnlockError =
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "rate-limited"; retryAt: number }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
  | { kind: "unknown" };

export const describeGateFailure = (error: unknown, now: number = Date.now()): ForensicsUnlockError => {
  if (!(error instanceof ForensicsGateError)) return { kind: "unavailable" };
  switch (error.status) {
    case 401:
      return error.message === "Session expired" ? { kind: "expired" } : { kind: "invalid" };
    case 429:
      return { kind: "rate-limited", retryAt: now + (error.retryAfter ?? 60) * 1000 };
    case 403:
      return { kind: "forbidden" };
    case 404:
    case 502:
    case 503:
    case 504:
      return { kind: "unavailable" };
    default:
      return { kind: "unknown" };
  }
};

export const formatWait = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`);

export const gateErrorMessage = (error: ForensicsUnlockError | null, waitS: number): string | null => {
  if (!error) return "That password didn't work. Check it and try again.";
  switch (error.kind) {
    case "invalid":
      return "That password didn't work. Check it and try again. After 10 wrong attempts the gate pauses for 15 minutes.";
    case "expired":
      return "Your unlock expired. Enter the password again.";
    case "rate-limited":
      // Static text so the alert is announced once; the live countdown is on the button.
      return waitS > 0 ? "Too many attempts. Unlock re-enables when the wait shown on the button is over." : "You can try again now.";
    case "unavailable":
      return "The password service is unavailable right now. Try again in a few minutes.";
    case "forbidden":
      return "Unlocking isn't allowed from this address. Open holderdistribution.com directly.";
    default:
      return "Something went wrong checking the password. Try again.";
  }
};
