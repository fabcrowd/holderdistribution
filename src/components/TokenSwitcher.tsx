import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProject } from "@/hooks/useProject";
import { LISTED_PROJECTS, getProject } from "@/lib/projects";
import { isSwitchShortcut, moveActive, filterTokens, switchTarget, type SwitchOption } from "@/lib/tokenSwitch";

type Props = {
  className?: string;
  /** Hides the token name below `sm`, leaving the logo and chevron. */
  compact?: boolean;
};

const OPTIONS: SwitchOption[] = LISTED_PROJECTS.map((entry) => {
  const project = getProject(entry.slug);
  return { slug: project.slug, name: project.name, ticker: project.ticker, image: project.image };
});

const OPTION_ROW = "flex h-11 cursor-pointer items-center gap-2.5 rounded px-2 text-sm";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const EDITABLE_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

/** Index of the current token in the unfiltered list; 0 when it is not listed. */
const indexOfSlug = (slug: string): number => Math.max(0, OPTIONS.findIndex((o) => o.slug === slug));

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || EDITABLE_TAGS.includes(target.tagName));

/** Any open modal dialog. Only checked while the switcher is closed, so its own Radix dialog never matches. */
const isModalDialogOpen = (): boolean =>
  document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]') !== null;

/** Jump between tokens: a combobox popover that keeps the reader's view (see switchTarget). */
export const TokenSwitcher = ({ className = "", compact = false }: Props) => {
  const { slug: current, project } = useProject();
  const navigate = useNavigate();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const filtered = filterTokens(OPTIONS, query);
  const activeOption = filtered[active];

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setActive(indexOfSlug(current));
    } else {
      setQuery("");
      setActive(0);
    }
  };

  // Ctrl+K / Cmd+K toggles the switcher from anywhere on the page, except while
  // the reader is typing in another field or a dialog owns the screen.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSwitchShortcut(e)) return;
      if (!open && (isEditableTarget(e.target) || isModalDialogOpen())) return;
      e.preventDefault();
      setOpen(!open);
      if (open) {
        setQuery("");
        setActive(0);
      } else {
        setActive(indexOfSlug(current));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, current]);

  const select = (slug: string) => {
    handleOpenChange(false);
    if (slug === current) return;
    navigate(switchTarget(slug, window.location.hash));
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(moveActive(active, filtered.length, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" || filtered.length === 0 ? 0 : filtered.length - 1);
    } else if (e.key === "Enter" && activeOption) {
      e.preventDefault();
      select(activeOption.slug);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="token-switcher"
          aria-expanded={open}
          aria-label={`Switch token, current: ${project.name}`}
          className={`inline-flex h-11 min-w-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 hover:border-border-strong hover:bg-muted/50 xl:h-9 ${FOCUS_RING} ${className}`}
        >
          {project.image && <img src={project.image} alt="" width={24} height={24} decoding="async" className="h-6 w-6 shrink-0 rounded-full" />}
          <span className={`min-w-0 truncate text-sm font-semibold text-foreground ${compact ? "hidden sm:block" : ""}`}>{project.name}</span>
          <span className="ha-num hidden text-xs text-muted-foreground 2xl:inline">{project.ticker}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Switch token" className="w-72 p-0 shadow-pop">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={filtered.length > 0 ? listId : undefined}
            aria-activedescendant={activeOption ? `${listId}-${activeOption.slug}` : undefined}
            aria-label="Search tokens"
            placeholder="Search tokens"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {filtered.length > 0 ? (
          <ul role="listbox" id={listId} aria-label="Tokens" className="max-h-72 overflow-y-auto p-1">
            {filtered.map((option, index) => {
              const selected = option.slug === current;
              return (
                <li
                  key={option.slug}
                  role="option"
                  id={`${listId}-${option.slug}`}
                  aria-selected={selected}
                  onClick={() => select(option.slug)}
                  onMouseMove={() => {
                    if (index !== active) setActive(index);
                  }}
                  className={`${OPTION_ROW} ${index === active ? "bg-muted" : ""}`}
                >
                  {option.image && <img src={option.image} alt="" width={24} height={24} decoding="async" className="h-6 w-6 shrink-0 rounded-full" />}
                  <span className="min-w-0 truncate font-medium text-foreground">{option.name}</span>
                  <span className="ha-num ml-auto text-xs text-muted-foreground">{option.ticker}</span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No tokens match.</p>
        )}
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <Link
            to="/"
            onClick={() => handleOpenChange(false)}
            className={`inline-flex min-h-11 items-center rounded underline-offset-2 hover:text-foreground hover:underline ${FOCUS_RING}`}
          >
            All tokens
          </Link>
          <kbd className="ha-num hidden rounded border border-border px-1.5 py-0.5 xl:inline">Ctrl K</kbd>
        </div>
      </PopoverContent>
    </Popover>
  );
};
