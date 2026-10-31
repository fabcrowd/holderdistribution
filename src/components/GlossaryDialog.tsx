import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMemo } from "react";
import { buildGlossary } from "@/lib/glossary";
import { useProject } from "@/hooks/useProject";
import { getProject } from "@/lib/projects";

/**
 * Header-level "Key terms" drawer. The page leans on crypto jargon (CEX, DEX,
 * escrow, legacy vs v3) that a newcomer can't decode from a 3-letter label,
 * and per-tile tooltips only explain one term at a time. One always-visible
 * entry point answers "what does this word mean?" from anywhere on the page.
 */
export const GlossaryDialog = ({
  className = "",
  labelClassName = "",
}: {
  className?: string;
  /** e.g. "sr-only xl:not-sr-only" for an icon-only trigger on narrower desktops. */
  labelClassName?: string;
}) => {
  const { slug } = useProject();
  const glossary = useMemo(() => buildGlossary(getProject(slug)), [slug]);
  return (
  <Sheet>
    <Tooltip>
      <TooltipTrigger asChild>
    <SheetTrigger asChild>
      <Button
        variant="ghost"
        size="sm"
        className={`min-h-[44px] gap-1.5 px-3 text-sm font-medium text-foreground/80 hover:text-foreground ${className}`}
      >
        <BookOpen aria-hidden="true" className="h-4 w-4 text-primary" />
        <span className={labelClassName}>Key terms</span>
      </Button>
    </SheetTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom">Key terms: what the labels mean</TooltipContent>
    </Tooltip>
    <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-md">
      <SheetHeader className="text-left">
        <SheetTitle>Key terms</SheetTitle>
        <SheetDescription>What the labels on this dashboard mean, in plain language.</SheetDescription>
      </SheetHeader>
      <dl className="mt-6 space-y-5">
        {glossary.map((t) => (
          <div key={t.id} id={`term-${t.id}`}>
            <dt className="text-sm font-semibold text-foreground">{t.term}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{t.definition}</dd>
          </div>
        ))}
      </dl>
    </SheetContent>
  </Sheet>
  );
};

export default GlossaryDialog;
