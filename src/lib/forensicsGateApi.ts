import { getSupabase } from "@/integrations/supabase/lazy";
import { forensicsPasswordMatches } from "@/lib/forensicsPasswordHash";
import { DEFAULT_PROJECT_SLUG } from "@/lib/projects";

export const FORENSICS_GATE_URL = "/.netlify/functions/forensics-gate";

export class ForensicsGateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds to wait, from the 429's Retry-After header. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ForensicsGateError";
  }
}

/** Session tokens issued by the gate look like `hdg1.<payload>.<sig>`. */
export const isGateToken = (credential: string | null | undefined): credential is string =>
  typeof credential === "string" && credential.startsWith("hdg1.");

export const SESSION_CHECK_KEY = "session-check";

/** Gate keys whose payload is a project-level `report` (not a wallet write-up). */
const PROJECT_REPORT_KEYS = new Set(["association-stablecoin-flows", "tel-disposition-ledger", "disposition-ledger"]);
const isProjectReportKey = (key: string) => PROJECT_REPORT_KEYS.has(key);

async function gateHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

type GateResponse = {
  analysis?: unknown;
  report?: unknown;
  /** Project the payload belongs to (absent on session checks). */
  project?: string;
  ok?: boolean;
  error?: string;
  /** Present when a password (not a token) authenticated the call. */
  token?: string;
  tokenExpiresAt?: number;
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
const loadLocalPayload = async (address: string, project?: string): Promise<GateResponse> => {
  if (!import.meta.env.DEV) {
    throw new ForensicsGateError("Could not load gated content", 503);
  }
  if (address === SESSION_CHECK_KEY) return { ok: true };
  // Dev has local copies of the default project's (TEL's) gated files only.
  if (project && project !== DEFAULT_PROJECT_SLUG) {
    // Other projects: only the wallet-flows report has a local file (data/<slug>/forensics/, uncommitted until pushed).
    if (address === "wallet-flows") {
      const { loadProjectWalletFlowsDev } = await import("@/lib/loadForensicsDev");
      return { report: await loadProjectWalletFlowsDev(project), project };
    }
    return isProjectReportKey(address) ? { report: null, project } : { analysis: null, project };
  }
  const { loadWalletAnalysisDev, loadAssociationFlowReportDev, loadDispositionLedgerDev, loadWalletFlowsDev } =
    await import("@/lib/loadForensicsDev");
  if (address === "wallet-flows") {
    return { report: await loadWalletFlowsDev() };
  }
  if (address === "association-stablecoin-flows") {
    return { report: await loadAssociationFlowReportDev() };
  }
  if (address === "tel-disposition-ledger" || address === "disposition-ledger") {
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
  project?: string,
): Promise<GateResponse> => {
  if (!import.meta.env.DEV) {
    throw new ForensicsGateError("Could not load gated content", 503);
  }
  if (!password || !(await forensicsPasswordMatches(password))) {
    throw new ForensicsGateError("Invalid password", 401);
  }
  return loadLocalPayload(address, project);
};

/**
 * POST to the Netlify forensics gate. `credential` is a session token from a
 * previous unlock (preferred) or the typed password (only during unlock).
 * Admins may omit it (session header). `project` is the active project slug
 * (useProject()); omitted = the default project (TEL), as before multi-token.
 */
export const fetchForensicsGate = async (
  address: string,
  credential?: string | null,
  project?: string,
): Promise<GateResponse> => {
  const normalized = address.trim().toLowerCase();
  const headers = await gateHeaders();
  const token = isGateToken(credential) ? credential : undefined;
  const password = token ? undefined : credential ?? undefined;

  let res: Response;
  try {
    res = await fetch(FORENSICS_GATE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ address: normalized, password, token, ...(project ? { project } : {}) }),
    });
  } catch {
    return fallbackWithPassword(normalized, password, project);
  }

  if (!res.ok) {
    if (gateUnavailable(res.status) && import.meta.env.DEV) {
      return fallbackWithPassword(normalized, password, project);
    }
    const retryAfter = Number(res.headers.get("Retry-After"));
    const message =
      res.status === 401
        ? token
          ? "Session expired"
          : "Invalid password"
        : res.status === 429
          ? "Too many attempts"
          : res.status === 403
            ? "Not allowed from this site"
            : gateUnavailable(res.status)
              ? "Gate unavailable"
              : "Could not load gated content";
    throw new ForensicsGateError(message, res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }

  return (await res.json()) as GateResponse;
};

export type UnlockResult = { credential: string; expiresAt: number | null };

/**
 * Exchange a password for a session credential. Returns the signed token when
 * the gate issues one, else (server without a signing secret, or dev) the
 * password itself, which the caller must keep in memory only. Resolves null
 * for a wrong password; throws ForensicsGateError for 429 / 403 / 503 etc.
 */
export const unlockWithPassword = async (password: string): Promise<UnlockResult | null> => {
  try {
    const res = await fetchForensicsGate(SESSION_CHECK_KEY, password);
    if (res.token) return { credential: res.token, expiresAt: res.tokenExpiresAt ?? null };
    return { credential: password, expiresAt: null };
  } catch (error) {
    if (error instanceof ForensicsGateError && error.status === 401) return null;
    throw error;
  }
};

/** Is a stored token still accepted? (401 → false; other failures throw.) */
export const checkSession = async (token: string): Promise<boolean> => {
  try {
    await fetchForensicsGate(SESSION_CHECK_KEY, token);
    return true;
  } catch (error) {
    if (error instanceof ForensicsGateError && error.status === 401) return false;
    throw error;
  }
};

/** Lightweight unlock check (kept for callers that only need yes/no). */
export const verifyForensicsPassword = async (password: string): Promise<boolean> =>
  (await unlockWithPassword(password)) !== null;
