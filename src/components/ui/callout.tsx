import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type CalloutProps = Omit<ComponentProps<"div">, "role" | "children"> & {
  children: ReactNode;
  /** Pass null to render the callout without an icon. */
  icon?: LucideIcon | null;
  role?: "status" | "alert";
};

/** Amber caution notice. The icon is decorative; the text carries the meaning. */
export function Callout({ children, icon, className, role, ...rest }: CalloutProps) {
  const Icon = icon === undefined ? AlertTriangle : icon;
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning-tint px-3.5 py-2.5 text-sm text-foreground",
        className,
      )}
      {...rest}
    >
      {Icon && <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
      <div className="min-w-0 leading-snug">{children}</div>
    </div>
  );
}
