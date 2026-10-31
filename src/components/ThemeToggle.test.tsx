import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ThemePreference } from "@/lib/theme";

const themeState: { preference: ThemePreference } = { preference: "system" };

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ preference: themeState.preference, resolved: "light", cycle: () => undefined }),
}));

import { ThemeToggle } from "./ThemeToggle";

const renderFor = (preference: ThemePreference) => {
  themeState.preference = preference;
  return renderToStaticMarkup(
    <TooltipProvider>
      <ThemeToggle />
    </TooltipProvider>,
  );
};

describe("ThemeToggle", () => {
  it.each([
    ["light", "Theme: Light. Switch theme.", "lucide-sun"],
    ["dark", "Theme: Dark. Switch theme.", "lucide-moon"],
    ["system", "Theme: System. Switch theme.", "lucide-monitor"],
  ] as const)("names the current %s choice and shows its icon", (preference, name, icon) => {
    const html = renderFor(preference);
    expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain(icon);
    expect(html).not.toContain("Colour theme");
  });
});
