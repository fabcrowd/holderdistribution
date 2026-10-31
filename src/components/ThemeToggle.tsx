import { Monitor, Moon, Sun } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/useTheme";

const LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

/** Cycles light -> dark -> system. The name and tooltip state the CURRENT setting. */
export const ThemeToggle = ({ className = "" }: { className?: string }) => {
  const { preference, cycle } = useTheme();
  const Icon = preference === "light" ? Sun : preference === "dark" ? Moon : Monitor;
  const copy = `Theme: ${LABEL[preference]}. Switch theme.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={cycle}
          aria-label={copy}
          className={`inline-flex h-8 w-8 max-xl:h-11 max-xl:w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{copy}</TooltipContent>
    </Tooltip>
  );
};
