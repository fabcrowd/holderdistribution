import { ExternalLink } from "lucide-react";
import { useProject } from "@/hooks/useProject";
import { stakedPanelTip } from "@/lib/stakedPanelTip";

/**
 * Body of the Holders "Staked" (i). Rendered inside the panel's InfoTip so
 * the proof links stay clickable. Copy and links are per project — see
 * stakedPanelTip.
 */
export const StakedPanelTip = () => {
  const { project } = useProject();
  const tip = stakedPanelTip(project);
  return (
    <div
      className="max-h-[min(70vh,28rem)] space-y-2 overflow-y-auto overscroll-contain whitespace-normal pr-1"
      data-testid="staked-panel-tip"
    >
      <p className="whitespace-pre-line">{tip.body}</p>
      {tip.links.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/50 pt-2">
          {tip.links.map((link) => (
            <a
              key={`${link.label}:${link.href}`}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {link.label} <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
};
