import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * The Supabase SDK (~45 KB gz) is only needed for the optional admin sign-in,
 * so it is loaded on demand instead of being a modulepreload in index.html.
 */
let clientPromise: Promise<SupabaseClient<Database>> | null = null;

export const getSupabase = (): Promise<SupabaseClient<Database>> => {
  clientPromise ??= import("./client").then((m) => m.supabase);
  return clientPromise;
};
