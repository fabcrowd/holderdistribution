import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { WALLET_ANALYSES, ASSOCIATION_FLOW_REPORT_KEY, ASSOCIATION_STABLECOIN_FLOWS, TEL_DISPOSITION_LEDGER_KEY, TEL_DISPOSITION_LEDGER } from './data.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Same SHA-256 as src/lib/localUnlock.ts so the gate still works when the
// FORENSICS_PASSWORD secret has not been set on the project.
const FORENSICS_PASSWORD_SHA256 =
  'dc1303c56ee8888310bd0560f5d0cb93a3e3ba4653630d6824aa56ba7c0463d8';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Simple in-memory rate limiter — same shape as fetch-tel-price/index.ts.
// Per-instance / resets on cold start, not a hard distributed guarantee, but
// meaningfully raises the bar over zero protection for this low-value
// shared password.
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 10; // 10 requests per minute per IP

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }

  if (record.count >= MAX_REQUESTS) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }

  record.count++;
  return { allowed: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIp =
    req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || 'unknown';

  const rateLimitResult = checkRateLimit(clientIp);
  if (!rateLimitResult.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': rateLimitResult.retryAfter?.toString() || '60',
      },
    });
  }

  try {
    const { address, password } = (await req.json()) as { address?: string; password?: string };
    if (!address) {
      return new Response(JSON.stringify({ error: 'address is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Admin bypass first: the caller's Supabase session (if any) is forwarded
    // automatically by supabase.functions.invoke() as the Authorization
    // header. Reuse the same has_role() check useUserRole.ts does
    // client-side — this is the server-side source of truth, not a flag the
    // client could ever spoof.
    let isAdmin = false;
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const authedClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await authedClient.auth.getUser();
      if (userData?.user) {
        const { data: hasRole } = await authedClient.rpc('has_role', {
          _user_id: userData.user.id,
          _role: 'admin',
        });
        isAdmin = hasRole === true;
      }
    }

    if (!isAdmin) {
      const expectedPassword = Deno.env.get('FORENSICS_PASSWORD');
      const hashed = password ? await sha256Hex(password) : '';
      const envOk = Boolean(expectedPassword && password === expectedPassword);
      const hashOk = hashed === FORENSICS_PASSWORD_SHA256;
      if (!envOk && !hashOk) {
        return new Response(JSON.stringify({ error: 'Invalid password' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Multi-wallet flow narratives share this endpoint (and therefore the
    // exact same auth above) rather than getting their own function — they
    // are the same kind of secret, just not keyed by a single address.
    const key = address.trim().toLowerCase();
    if (key === ASSOCIATION_FLOW_REPORT_KEY) {
      return new Response(JSON.stringify({ report: ASSOCIATION_STABLECOIN_FLOWS }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (key === TEL_DISPOSITION_LEDGER_KEY) {
      return new Response(JSON.stringify({ report: TEL_DISPOSITION_LEDGER }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const analysis = WALLET_ANALYSES[key] ?? null;
    return new Response(JSON.stringify({ analysis }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('wallet-analysis-gate error:', error);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
