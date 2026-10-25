import { ExternalLink } from "lucide-react";
import { InfoTip } from "@/components/InfoTip";
import { useMemo } from "react";
import { useProject } from "@/hooks/useProject";
import { methodologyFor, type Methodology, type MethodologyKey } from "@/lib/methodology";

type MethodologyInfoProps = {
  /** Methodology section key (filled for the active project), or an inline methodology object. */
  section: MethodologyKey | Methodology;
  className?: string;
};

/**
 * "How this works / verify on-chain" explainer for a section title. Built on
 * InfoTip (a Popover), so it opens on click / tap as well as on mouse hover —
 * the previous HoverCard never opened on a phone tap — and its on-chain
 * verification links stay clickable. The trigger keeps a 24x24px hit area and
 * stops propagation so parent collapsible headers don't toggle.
 */
export const MethodologyInfo = ({ section, className }: MethodologyInfoProps) => {
  const { project } = useProject();
  const data = useMemo(
    () => (typeof section === "string" ? methodologyFor(project, section) : section),
    [project, section],
  );
  if (!data) return null;
  return (
    <InfoTip
      label="How this works and how to verify it on-chain"
      align="start"
      className={`text-muted-foreground/80 hover:text-primary ${className ?? ""}`}
      iconClassName="h-4 w-4"
      content={
        <div className="space-y-2 whitespace-normal">
          <div>
            <span className="font-semibold text-foreground">How it works. </span>
            <span className="text-muted-foreground">{data.how}</span>
          </div>
          <div>
            <span className="font-semibold text-foreground">Verify on-chain. </span>
            <span className="text-muted-foreground">{data.verify}</span>
          </div>
          {data.links.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/50 pt-2">
              {data.links.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {l.label} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ))}
            </div>
          )}
        </div>
      }
    />
  );
};
