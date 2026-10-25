import { Link, useLocation } from "react-router-dom";
import { LogOut, PieChart, Shield, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetTrigger, SheetClose } from "@/components/ui/sheet";
import logo from "@/assets/holder-analytics-horizontal.svg";
import { GlossaryDialog } from "@/components/GlossaryDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TokenSwitcher } from "@/components/TokenSwitcher";

type NavigationProps = {
  /** Optional page name shown beside the logo. The mobile nav is otherwise
   *  just a logo and a hamburger — it carries no active state and no page
   *  name — so a page that wants an identity marker on a phone has to put it
   *  here. Pages that don't pass it render exactly as before. */
  pageTitle?: string;
};

export const Navigation = ({ pageTitle }: NavigationProps = {}) => {
  const location = useLocation();
  const { isAuthenticated, signOut } = useAuth();
  const { isAdmin } = useUserRole();
  const isMobile = useIsMobile();

  // This repo is a single-page extraction of the Holders/Tokenomics section
  // from the original multi-page hub — no other routes exist here, so there is
  // nothing left to navigate to. navItems is empty rather than removed
  // wholesale, so re-adding a route later is a one-line change, not a rewrite
  // of the render logic below.
  const navItems: { to: string; label: string; icon: typeof PieChart }[] = [];

  return (
    <nav
      className="sticky top-0 z-50 w-full backdrop-blur-xl premium-nav"
    >
      <div className="mx-auto px-4 max-w-7xl">
        <div className="flex h-16 md:h-20 items-center justify-between">
          {/* Logo (+ optional page title) */}
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            <Link to="/" className="flex items-center gap-2 group shrink-0">
              <img src={logo} alt="Holder Analytics" width={196} height={48} fetchPriority="high" decoding="async" className="h-8 md:h-10 w-auto transition-opacity group-hover:opacity-80" />
            </Link>
            {/* Hidden from lg up, where the nav's own links start rendering
                their text labels (`hidden lg:inline` below) and the active
                pill already names the page — showing both reads as a
                stutter. Hidden below sm too: a phone only has room for
                "Token…", and the hero heading directly beneath already names
                the page. Between sm and lg it's the only page identity. */}
            {pageTitle && (
              <span className="hidden sm:inline lg:hidden truncate border-l border-primary/25 pl-2 md:pl-3 text-base md:text-lg font-bold text-foreground">
                {pageTitle}
              </span>
            )}
          </div>

          {/* Always visible, phone included: the jargon problem is worst for
              exactly the newcomer who has no other way to decode it. */}
          {/* Master token switch on phones only; md+ uses the page-title switcher. */}
          <TokenSwitcher variant="pill" className="ml-auto mr-1 md:hidden" />
          <GlossaryDialog className="md:ml-auto" />
          <ThemeToggle className="h-11 w-11" />

          {/* Desktop Navigation Links */}
          <div className="hidden md:flex items-center gap-1 lg:gap-2">
            {navItems.map(({ to, label, icon: Icon }) => {
              const isActive = location.pathname === to;
              return (
                <Link
                  key={to}
                  to={to}
                  className={cn(
                    "flex items-center justify-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-2.5 min-h-[44px] rounded-lg text-xs lg:text-sm font-medium transition-all touch-manipulation active:scale-95",
                    isActive
                      ? "bg-card/80 text-primary border border-primary/35 shadow-sm shadow-primary/20"
                      : "text-foreground/75 hover:text-foreground hover:bg-card/50",
                  )}
                >
                  <Icon className="h-4 w-4 lg:h-5 lg:w-5 flex-shrink-0" />
                  <span className="hidden lg:inline">{label}</span>
                </Link>
              );
            })}

            {/* Admin Badge */}
            {isAuthenticated && isAdmin && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Shield className="h-3 w-3" />
                Admin
              </Badge>
            )}

            {/* Logout Button (only when authenticated) */}
            {isAuthenticated && (
              <Button
                variant="ghost"
                size="sm"
                onClick={signOut}
                className="min-h-[44px] min-w-[44px] touch-manipulation"
              >
                <LogOut className="h-5 w-5" />
                <span className="hidden lg:inline ml-2">Logout</span>
              </Button>
            )}
          </div>

          {/* Mobile Hamburger Menu — hidden when there is nothing to show */}
          {(navItems.length > 0 || isAuthenticated) && (
          <div className="md:hidden flex items-center gap-1">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-10 w-10 text-foreground hover:bg-card/50">
                  <Menu className="h-6 w-6" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 p-0">
                <div className="flex flex-col h-full">
                  {/* Header */}
                  <div className="flex items-center p-4 border-b border-border/40">
                    <img src={logo} alt="Holder Analytics" width={131} height={32} className="h-8 w-auto" />
                  </div>

                  {/* Nav Items */}
                  <div className="flex-1 overflow-y-auto py-4">
                    {navItems.map(({ to, label, icon: Icon }) => {
                      const isActive = location.pathname === to;
                      return (
                        <SheetClose asChild key={to}>
                          <Link
                            to={to}
                            className={cn(
                              "flex items-center gap-3 px-4 py-3 min-h-[48px] text-base font-medium transition-all active:scale-[0.98]",
                              isActive
                                ? "bg-primary/20 text-primary border-l-4 border-primary"
                                : "text-foreground hover:bg-accent/50",
                            )}
                          >
                            <Icon className="h-5 w-5 flex-shrink-0" />
                            <span>{label}</span>
                          </Link>
                        </SheetClose>
                      );
                    })}
                  </div>

                  {/* Footer with Auth */}
                  {isAuthenticated && (
                    <div className="border-t border-border/40 p-4 space-y-3">
                      {isAdmin && (
                        <Badge variant="secondary" className="flex items-center gap-1 w-fit">
                          <Shield className="h-3 w-3" />
                          Admin
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={signOut}
                        className="w-full"
                      >
                        <LogOut className="h-4 w-4 mr-2" />
                        Logout
                      </Button>
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
          )}
        </div>
      </div>
    </nav>
  );
};
