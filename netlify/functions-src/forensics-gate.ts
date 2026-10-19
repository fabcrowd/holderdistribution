import { createClient } from "@supabase/supabase-js";
import {
  ASSOCIATION_FLOW_REPORT_KEY,
  ASSOCIATION_STABLECOIN_FLOWS,
  WALLET_ANALYSES,
} from "../../src/data/forensicsWriteups.ts";
import {
  TEL_DISPOSITION_LEDGER,
} from "../../supabase/functions/wallet-analysis-gate/tel-disposition.generated.ts";
import type { Handler } from "@netlify/functions";
import { WindowLimiter, corsHeaders, originAllowed, passwordMatches } from "./gateAuth.ts";
import { loadWalletFlows } from "./walletFlowsSource.ts";

/**
 * Password-gated forensics endpoint. POST {address, password}. Every gated
 * payload (write-ups, ledger, wallet flows) is bundled into THIS function only —
 * none of it is in public/ or the client bundle. See docs/FORENSICS.md.
 */
const TEL_DISPOSITION_LEDGER_KEY = "tel-disposition-ledger";
export const WALLET_FLOWS_KEY = "wallet-flows";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "https://svvjdtmvmqdejjqxzclp.supabase.co";
// Public anon key (the same one shipped in src/integrations/supabase/client.ts; RLS
// enforces access). Without this default the admin-session path silently never
// worked, because no SUPABASE_* variable is set in Netlify.
const PUBLIC_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmpkdG12bXFkZWpqcXh6Y2xwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4MjEyNDksImV4cCI6MjA3NTM5NzI0OX0.ENPC-zov9byGwSYIu11wMnz5r4FpdU85tBBKvIJdB14";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  PUBLIC_SUPABASE_ANON_KEY;

/** 20 requests / minute / IP overall, and 10 failed passwords / 15 minutes / IP. */
const requestLimiter = new WindowLimiter(20, 60_000);
const failureLimiter = new WindowLimiter(10, 15 * 60_000);

async function isAdmin(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader || !/^Bearer\s+\S+/.test(authHeader) || !SUPABASE_ANON_KEY) return false;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await client.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return false;
    const { data, error } = await client
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

type GateEvent = Parameters<Handler>[0];

const header = (event: GateEvent, name: string): string | undefined => {
  const headers = (event.headers ?? {}) as Record<string, string | undefined>;
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
};

export async function handler(event: GateEvent): ReturnType<Handler> {
  const origin = header(event, "origin");
  const cors = corsHeaders(origin);
  const json = (statusCode: number, body: unknown, extra: Record<string, string> = {}) => ({
    statusCode,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
    body: JSON.stringify(body),
  });

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: originAllowed(origin) ? 204 : 403, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!originAllowed(origin)) return json(403, { error: "Origin not allowed" });

  const clientIp =
    header(event, "x-nf-client-connection-ip") ||
    header(event, "x-forwarded-for")?.split(",")[0]?.trim() ||
    header(event, "client-ip") ||
    "unknown";

  const rate = requestLimiter.hit(clientIp);
  if (!rate.allowed) {
    return json(429, { error: "Too many requests. Please try again later." }, { "Retry-After": String(rate.retryAfter || 60) });
  }
  const lockout = failureLimiter.blocked(clientIp);
  if (lockout.blocked) {
    return json(429, { error: "Too many failed attempts. Please try again later." }, { "Retry-After": String(lockout.retryAfter || 900) });
  }

  try {
    const body = JSON.parse(event.body ?? "{}") as { address?: string; password?: string };
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!address) return json(400, { error: "address is required" });

    const admin = await isAdmin(header(event, "authorization"));
    if (!admin && !passwordMatches(body.password)) {
      failureLimiter.hit(clientIp);
      return json(401, { error: "Invalid password" });
    }
    failureLimiter.clear(clientIp);

    if (address === ASSOCIATION_FLOW_REPORT_KEY) return json(200, { report: ASSOCIATION_STABLECOIN_FLOWS });
    if (address === TEL_DISPOSITION_LEDGER_KEY) return json(200, { report: TEL_DISPOSITION_LEDGER });
    if (address === WALLET_FLOWS_KEY) {
      const { report, source } = await loadWalletFlows();
      return json(200, { report }, { "X-Wallet-Flows-Source": source });
    }

    const analysis = WALLET_ANALYSES[address] ?? null;
    return json(200, { analysis });
  } catch (error) {
    console.error("forensics-gate error:", error);
    return json(500, { error: "Internal error" });
  }
}
