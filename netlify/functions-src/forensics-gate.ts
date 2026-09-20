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
import { forensicsPasswordMatches } from "../../src/lib/forensicsPasswordHash.ts";

const TEL_DISPOSITION_LEDGER_KEY = "tel-disposition-ledger";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "https://svvjdtmvmqdejjqxzclp.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  "";

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.ceil((record.resetTime - now) / 1000) };
  }
  record.count++;
  return { allowed: true };
}

async function isAdmin(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader || !SUPABASE_ANON_KEY) return false;
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
}

async function passwordOk(password: string | undefined): Promise<boolean> {
  if (!password) return false;
  const expected = process.env.FORENSICS_PASSWORD;
  if (expected && password === expected) return true;
  return forensicsPasswordMatches(password);
}

export async function handler(event: Parameters<Handler>[0]): ReturnType<Handler> {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const clientIp =
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    event.headers["client-ip"] ||
    event.headers["x-nf-client-connection-ip"] ||
    "unknown";

  const rate = checkRateLimit(clientIp);
  if (!rate.allowed) {
    return {
      statusCode: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(rate.retryAfter ?? 60),
      },
      body: JSON.stringify({ error: "Too many requests. Please try again later." }),
    };
  }

  try {
    const body = JSON.parse(event.body ?? "{}") as { address?: string; password?: string };
    const address = body.address?.trim().toLowerCase();
    if (!address) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "address is required" }),
      };
    }

    const admin = await isAdmin(event.headers.authorization);
    if (!admin && !(await passwordOk(body.password))) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid password" }),
      };
    }

    if (address === ASSOCIATION_FLOW_REPORT_KEY) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ report: ASSOCIATION_STABLECOIN_FLOWS }),
      };
    }

    if (address === TEL_DISPOSITION_LEDGER_KEY) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ report: TEL_DISPOSITION_LEDGER }),
      };
    }

    const analysis = WALLET_ANALYSES[address] ?? null;
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ analysis }),
    };
  } catch (error) {
    console.error("forensics-gate error:", error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}
