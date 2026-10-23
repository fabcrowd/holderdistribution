import { useUserRole } from "@/hooks/useUserRole";
import { useForensicsUnlock } from "@/components/ForensicsGate";

/** Whether gated Supply content is visible (admin or unlocked) — the same
 *  test SubscriptionGate applies, for layouts that size around it. */
export const useForensicsAccess = () => {
  const { isAdmin, isLoading, authLoading } = useUserRole();
  const { password, status } = useForensicsUnlock();
  const checking = authLoading || isLoading || status === "checking";
  return { checking, unlocked: isAdmin || password !== null };
};
