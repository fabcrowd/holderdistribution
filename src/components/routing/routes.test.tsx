import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { __resetActiveSlug } from "@/lib/projectStore";
import { TokenRoute } from "./TokenRoute";
import { LegacyRedirect } from "./LegacyRedirect";

const at = (url: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<LegacyRedirect><div data-testid="landing" /></LegacyRedirect>} />
        <Route path="/holders" element={<LegacyRedirect />} />
        <Route path="/:slug" element={<TokenRoute notFound={<div data-testid="nf" />}><div data-testid="terminal" /></TokenRoute>} />
        <Route path="*" element={<div data-testid="nf" />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => __resetActiveSlug("tel"));

describe("token routes", () => {
  it("/ renders the landing page", () => {
    expect(at("/")).toContain('data-testid="landing"');
  });
  it("/<mapped slug> renders the terminal once the store matches the slug", () => {
    __resetActiveSlug("tel");
    expect(at("/tel")).toContain('data-testid="terminal"');
    __resetActiveSlug("zebec-network");
    expect(at("/zebec-network")).toContain('data-testid="terminal"');
  });
  it("does not render another token's terminal before the store syncs", () => {
    __resetActiveSlug("tel");
    expect(at("/zebec-network")).not.toContain('data-testid="terminal"');
  });
  it("unknown slugs and nested paths render the 404", () => {
    expect(at("/not-a-token")).toContain('data-testid="nf"');
    expect(at("/tel/extra")).toContain('data-testid="nf"');
  });
  it("legacy URLs do not render the landing page (they redirect)", () => {
    expect(at("/?token=tel")).not.toContain('data-testid="landing"');
    expect(at("/holders")).toBe("");
  });
});
