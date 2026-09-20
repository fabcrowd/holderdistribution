/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TEL_ETHEREUM_CONTRACT?: string;
  readonly VITE_TEL_POLYGON_CONTRACT?: string;
  readonly VITE_ETHERSCAN_API_KEY?: string;
  readonly VITE_POLYGONSCAN_API_KEY?: string;
  readonly VITE_HOLDER_SNAPSHOT_URL?: string;
  readonly VITE_HOLDER_SNAPSHOT_API_KEY?: string;
  readonly VITE_HOLDER_SNAPSHOT_AUTH_TOKEN?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
