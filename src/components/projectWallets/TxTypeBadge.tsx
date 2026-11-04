import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { txTypeInfo, txTypeTone, type TxTypeInfo } from "@/lib/txTypes";

const TONE_CLASS = {
  negative: "border-negative/40 bg-negative-tint text-negative",
  neutral: "border-brand/30 bg-brand-tint text-brand",
  positive: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  muted: "border-border/60 bg-muted/40 text-muted-foreground",
} as const;

/** Transaction type chip; the tooltip says what the type means and how it was identified. */
export const TxTypeBadge = ({ type, types, reason }: { type: string; types?: Record<string, TxTypeInfo> | null; reason?: string }) => {
  const info = txTypeInfo(type, types);
  return (
    <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium ${TONE_CLASS[txTypeTone(type, info)]}`} data-testid={`tx-type-${type}`}>
          {info.label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        <p className="font-semibold">{info.label}{info.headline ? " · counts as developer selling" : info.internal ? " · internal, not counted" : ""}</p>
        <p className="mt-1">{info.meaning}</p>
        <p className="mt-1 text-muted-foreground">Identified by: {info.identifiedBy}</p>
        {reason && <p className="mt-1 text-muted-foreground">This transfer: {reason}</p>}
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
};
