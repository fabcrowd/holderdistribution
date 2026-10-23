import { useQuery } from "@tanstack/react-query";
import { getSupabase } from "@/integrations/supabase/lazy";
import { useAuth } from "./useAuth";

export const useUserRole = () => {
  const { user, isAuthenticated, loading: authLoading } = useAuth();

  const { data: isAdmin, isLoading } = useQuery({
    queryKey: ["user-role", user?.id],
    queryFn: async () => {
      if (!user?.id) return false;
      const supabase = await getSupabase();

      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();

      if (error) {
        console.error("Error fetching user role:", error);
        return false;
      }

      return !!data;
    },
    enabled: isAuthenticated && !!user?.id,
    staleTime: 1000 * 60 * 30, // Cache for 30 minutes
    gcTime: 1000 * 60 * 60, // Keep in cache for 1 hour
  });

  return {
    isAdmin: isAdmin ?? false,
    isLoading,
    isAuthenticated,
    authLoading,
  };
};
