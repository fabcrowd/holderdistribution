import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { legacyRedirect } from "@/lib/tokenRoutes";

/** Old entry points (/?token=, /holders) → /<slug> with a history replace. */
export const LegacyRedirect = ({ children = null }: { children?: ReactNode }) => {
  const location = useLocation();
  const to = legacyRedirect(location);
  if (to) return <Navigate to={to} replace />;
  return <>{children}</>;
};

export default LegacyRedirect;
