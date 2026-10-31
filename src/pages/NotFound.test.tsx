import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "./NotFound";

describe("NotFound", () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/nope"]}>
          <NotFound />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  it("wraps the message in the site header and footer", () => {
    expect(html).toContain("<nav ");
    expect(html).toContain("Support Holder Analytics");
    expect(html.indexOf("<nav ")).toBeLessThan(html.indexOf('data-testid="not-found"'));
    expect(html.indexOf('data-testid="not-found"')).toBeLessThan(html.indexOf("Support Holder Analytics"));
  });

  it("fills the viewport with the footer pinned below a growing main", () => {
    expect(html).toContain("min-h-[100svh]");
    expect(html).toMatch(/<main[^>]*class="[^"]*flex-1/);
  });

  it("does not name a token in the header on an unmapped path", () => {
    expect(html).not.toContain('data-testid="token-identity"');
  });

  it("balances the body text and keeps the home button", () => {
    expect(html).toMatch(/<p class="[^"]*text-balance[^"]*">There/);
    expect(html).toContain("Go to home");
  });
});
