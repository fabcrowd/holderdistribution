import { supabase } from "@/integrations/supabase/client";
import { forensicsPasswordMatches } from "@/lib/forensicsPasswordHash";

export const FORENSICS_GATE_URL = "/.netlify/functions/forensics-gate";

export class ForensicsGateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ForensicsGateError";
  }
}

async function gateHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

type GateResponse = {
  analysis?: unknown;
  report?: unknown;
  error?: string;
};

const gateUnavailable = (status: number) => status === 404 || status === 502 || status === 503;

/**
 * Local payload when the Netlify function is missing or down (hash check only).
 *
 * DEV ONLY, and the `import.meta.env.DEV` test below is load-bearing security,
 * not a convenience. `loadForensicsDev` statically imports the write-ups, so
 * anything that can reach it pulls src/data/forensicsWriteups.ts into the graph
 * and Vite emits it as a plain chunk under dist/assets/ — fetchable by URL with
 * no password at all. That is exactly what happened: forensicsWriteups-*.js was
 * served 200 from production with the full report in it, while a comment in
 * loadForensicsDev.ts asserted a DEV guard that did not exist anywhere.
 *
 * Vite statically replaces import.meta.env.DEV with false for a production
 * build, so this branch (and the whole dev module behind it) is dropped.
 * Verified by grepping dist/assets after `npm run build`.
 */
const loadLocalPayload = async (address: string): Promise<GateResponse> => {
  if (!import.meta.env.DEV) {
    throw new ForensicsGateError("Could not load gated content", 503);
  }
  const { loadWalletAnalysisDev, loadAssociationFlowReportDev, loadDispositionLedgerDev } =
    await import("@/lib/loadForensicsDev");
  if (address === "association-stablecoin-flows") {
    return { report: await loadAssociationFlowReportDev() };
  }
  if (address === "tel-disposition-ledger") {
    return { report: await loadDispositionLedgerDev() };
  }
  return { analysis: await loadWalletAnalysisDev(address) };
};

/**
 * In production this fails closed: if the gate is unreachable there is no
 * local copy to fall back to, so gated content simply does not render. A
 * degraded panel is the correct outcome; serving the payload from the bundle
 * to keep the UI working would defeat the gate entirely.
 */
const fallbackWithPassword = async (
  address: string,
  password: string | null | undefined,
): Promise<GateResponse> => {
  if (!import.meta.env.DEV) {
    throw new ForensicsGateError("Could not load gated content", 503);
  }
  if (!password || !(await forensicsPasswordMatches(password))) {
    throw new ForensicsGateError("Invalid password", 401);
  }
  return loadLocalPayload(address);
};

/** POST to the Netlify forensics gate. Admins may omit password (session header). */
export const fetchForensicsGate = async (
  address: string,
  password?: string | null,
): Promise<GateResponse> => {
  const normalized = address.trim().toLowerCase();
  const headers = await gateHeaders();

  let res: Response;
  try {
    res = await fetch(FORENSICS_GATE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        address: normalized,
        password: password ?? undefined,
      }),
    });
  } catch {
    return fallbackWithPassword(normalized, password);
  }

  if (!res.ok) {
    if (gateUnavailable(res.status)) {
      return fallbackWithPassword(normalized, password);
    }
    const message =
      res.status === 401
        ? "Invalid password"
        : res.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "Could not load gated content";
    throw new ForensicsGateError(message, res.status);
  }

  return (await res.json()) as GateResponse;
};

/** Lightweight unlock check — hits the gate (or hash fallback if the function is down). */
export const verifyForensicsPassword = async (password: string): Promise<boolean> => {
  try {
    await fetchForensicsGate("association-stablecoin-flows", password);
    return true;
  } catch (error) {
    if (error instanceof ForensicsGateError && error.status === 401) return false;
    throw error;
  }
};
