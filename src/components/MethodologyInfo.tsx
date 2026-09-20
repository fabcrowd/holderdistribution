import { Info, ExternalLink } from "lucide-react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { METHODOLOGY, type Methodology } from "@/lib/methodology";

type MethodologyInfoProps = {
  /** Key into METHODOLOGY, or an inline methodology object. */
  section: keyof typeof METHODOLOGY | Methodology;
  className?: string;
};

/**
 * Interactive "how this works / verify on-chain" hover card for a section
 * title. Unlike the plain InfoTooltip, its content is interactive so the
 * on-chain verification links are clickable. Opens on hover and on tap.
 */
export const MethodologyInfo = ({ section, className }: MethodologyInfoProps) => {
  const data = typeof section === "string" ? METHODOLOGY[section] : section;
  if (!data) return null;
  return (
    <HoverCard openDelay={80} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="How this works and how to verify it on-chain"
          className={`inline-flex items-center justify-center text-muted-foreground/60 hover:text-primary transition-colors ${className ?? ""}`}
          onClick={(e) => {
            // Parent collapsible headers are full-width triggers; keep this
            // info control from toggling the section open/closed.
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Info className="h-4 w-4" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 text-xs leading-relaxed space-y-2">
        <div>
          <span className="font-semibold text-foreground">How it works. </span>
          <span className="text-muted-foreground">{data.how}</span>
        </div>
        <div>
          <span className="font-semibold text-foreground">Verify on-chain. </span>
          <span className="text-muted-foreground">{data.verify}</span>
        </div>
        {data.links.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 border-t border-border/50">
            {data.links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {l.label} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
};
