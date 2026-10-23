import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { GLOSSARY } from "@/lib/glossary";

/**
 * Header-level "Key terms" drawer. The page leans on crypto jargon (CEX, DEX,
 * escrow, legacy vs v3) that a newcomer can't decode from a 3-letter label,
 * and per-tile tooltips only explain one term at a time. One always-visible
 * entry point answers "what does this word mean?" from anywhere on the page.
 */
export const GlossaryDialog = ({ className = "" }: { className?: string }) => (
  <Sheet>
    <SheetTrigger asChild>
      <Button
        variant="ghost"
        size="sm"
        className={`min-h-[44px] gap-1.5 px-3 text-sm font-medium text-foreground/80 hover:text-foreground ${className}`}
      >
        <BookOpen aria-hidden="true" className="h-4 w-4 text-primary" />
        <span>Key terms</span>
      </Button>
    </SheetTrigger>
    <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-md">
      <SheetHeader className="text-left">
        <SheetTitle>Key terms</SheetTitle>
        <SheetDescription>What the labels on this dashboard mean, in plain language.</SheetDescription>
      </SheetHeader>
      <dl className="mt-6 space-y-5">
        {GLOSSARY.map((t) => (
          <div key={t.id} id={`term-${t.id}`}>
            <dt className="text-sm font-semibold text-foreground">{t.term}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{t.definition}</dd>
          </div>
        ))}
      </dl>
    </SheetContent>
  </Sheet>
);

export default GlossaryDialog;
