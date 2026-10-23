import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type InfoTooltipProps = {
  /** Explainer text. Use \n for paragraph breaks. */
  text: string;
  className?: string;
};

/**
 * Small inline "info" icon with a hover/tap tooltip. Used to explain how a
 * metric is derived (e.g. how exchange hot wallets work) without cluttering
 * the tile. Works on touch (Radix opens on tap) and keyboard focus.
 */
export const InfoTooltip = ({ text, className }: InfoTooltipProps) => (
  <Tooltip delayDuration={100}>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label="More information"
        className={`inline-flex items-center justify-center text-muted-foreground/80 hover:text-primary transition-colors ${className ?? ""}`}
        onClick={(e) => e.preventDefault()}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs whitespace-pre-line text-xs leading-relaxed">
      {text}
    </TooltipContent>
  </Tooltip>
);
