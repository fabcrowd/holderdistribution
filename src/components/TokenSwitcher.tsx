import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProject } from "@/hooks/useProject";
import { TOKEN_PARAM, withToken } from "@/lib/projects";

type Props = {
  /** "heading": the ticker inside the terminal h1 (desktop). "pill": a compact chip (mobile nav). */
  variant?: "heading" | "pill";
  className?: string;
};

/**
 * Master token switch. Sets the active project for every view; the choice is
 * written to ?token= (shareable) and localStorage (remembered). Each option is
 * a real link so it can be opened in a new tab or copied.
 */
export const TokenSwitcher = ({ variant = "pill", className = "" }: Props) => {
  const { slug, project, projects, setProject } = useProject();
  const [open, setOpen] = useState(false);

  const hrefFor = (s: string) =>
    typeof window === "undefined"
      ? `?${TOKEN_PARAM}=${s}`
      : (withToken(window.location, s) ?? `${window.location.pathname}${window.location.search}${window.location.hash}`);

  const trigger =
    variant === "heading"
      ? "inline-flex items-center gap-0.5 rounded px-0.5 -mx-0.5 text-primary hover:bg-primary/10"
      : "inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card px-2.5 text-xs font-semibold text-foreground hover:bg-muted";

  // One master switch lives in the sticky header; the heading variant is
  // always a plain ticker label so there is never a second dropdown.
  if (variant === "heading") {
    return (
      <span className={`text-primary ${className}`} data-testid="token-ticker-label">
        {project.ticker}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="token-switcher"
          aria-label={`Token: ${project.name} (${project.ticker}). Switch token`}
          title="Switch token"
          className={`${trigger} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
        >
          <span>{project.ticker}</span>
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1" data-testid="token-switcher-menu">
        <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Mapped tokens
        </p>
        <ul role="list" className="space-y-0.5">
          {projects.map((p) => {
            const active = p.slug === slug;
            return (
              <li key={p.slug}>
                <a
                  href={hrefFor(p.slug)}
                  aria-current={active ? "true" : undefined}
                  data-slug={p.slug}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    setProject(p.slug);
                    setOpen(false);
                  }}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
                  }`}
                >
                  <span className="w-12 shrink-0 font-mono text-xs font-bold">{p.ticker}</span>
                  <span className="flex-1 truncate">{p.name}</span>
                  {active && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                </a>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
};

export default TokenSwitcher;
