import { useQuery } from "@tanstack/react-query";
import { loadWalletAnalysis, type WalletAnalysis } from "@/lib/loadForensics";

export type { WalletAnalysis };

/**
 * Loads one wallet's forensic write-up after the Supply password gate has
 * opened (or via admin session on the gate). Content is served by Netlify.
 */
export const useWalletAnalysis = (
  address: string | null,
  password: string | null,
  adminBypass = false,
) => {
  const normalized = address?.trim().toLowerCase() ?? null;
  return useQuery({
    queryKey: ["wallet-analysis", normalized, password, adminBypass],
    queryFn: async (): Promise<WalletAnalysis | null> => {
      if (!normalized) return null;
      return loadWalletAnalysis(normalized, password);
    },
    enabled: !!normalized && (adminBypass || password !== null),
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
};
