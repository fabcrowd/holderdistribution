/// <reference types="vite/client" />

// Only public, non-secret values may be exposed to the browser via VITE_*.
// Anything declared here is inlined into the client bundle at build time —
// never add API keys or tokens (see docs/DEPLOYMENT.md).
interface ImportMetaEnv {
  /** Canonical site origin used for canonical/OG URLs. Default https://holderdistribution.com */
  readonly VITE_SITE_URL?: string;
  /** Supabase project URL / anon (publishable) key. Defaults to the production project. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Optional override for the holders-history JSON feed. */
  readonly VITE_HOLDER_HISTORY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
