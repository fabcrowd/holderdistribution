import { describe, expect, it } from "vitest";
import registry from "../../config/projects.json";
import { RESERVED_ROOT_SEGMENTS, legacyRedirect, slugFromPath, tokenPath } from "./tokenRoutes";

const known = ["tel", "zebec-network"];
const loc = (pathname: string, search = "", hash = "") => ({ pathname, search, hash });

describe("tokenPath / slugFromPath", () => {
  it("puts the slug at the root", () => {
    expect(tokenPath("tel")).toBe("/tel");
    expect(tokenPath("zebec-network")).toBe("/zebec-network");
  });
  it("reads a mapped slug from the first and only segment", () => {
    expect(slugFromPath("/tel", known)).toBe("tel");
    expect(slugFromPath("/zebec-network/", known)).toBe("zebec-network");
  });
  it("returns null for the root, unknown slugs, nested paths and case variants", () => {
    expect(slugFromPath("/", known)).toBeNull();
    expect(slugFromPath("/not-a-token", known)).toBeNull();
    expect(slugFromPath("/tel/extra", known)).toBeNull();
    expect(slugFromPath("/TEL", known)).toBeNull();
    expect(slugFromPath("/holders", known)).toBeNull();
  });
});

describe("legacyRedirect", () => {
  it("leaves the plain landing page alone (no auto-redirect to a saved token)", () => {
    expect(legacyRedirect(loc("/"), known, "tel")).toBeNull();
    expect(legacyRedirect(loc("/", "?range=30"), known, "tel")).toBeNull();
  });
  it("/?token=<slug> goes to /<slug>, keeping other params and the hash", () => {
    expect(legacyRedirect(loc("/", "?token=zebec-network"), known, "tel")).toBe("/zebec-network");
    expect(legacyRedirect(loc("/", "?range=30&token=TEL", "#supply"), known, "tel")).toBe("/tel?range=30#supply");
  });
  it("/holders goes to the default slug; /holders?token=<slug> to that slug", () => {
    expect(legacyRedirect(loc("/holders"), known, "tel")).toBe("/tel");
    expect(legacyRedirect(loc("/holders/", "", "#distribution"), known, "tel")).toBe("/tel#distribution");
    expect(legacyRedirect(loc("/holders", "?token=zebec-network&chain=solana"), known, "tel")).toBe(
      "/zebec-network?chain=solana",
    );
  });
  it("an unmapped ?token= value goes to the landing page", () => {
    expect(legacyRedirect(loc("/", "?token=nope"), known, "tel")).toBe("/");
    expect(legacyRedirect(loc("/holders", "?token=../../etc"), known, "tel")).toBe("/");
    expect(legacyRedirect(loc("/", "?token="), known, "tel")).toBe("/");
  });
  it("ignores every other path", () => {
    expect(legacyRedirect(loc("/tel", "?token=zebec-network"), known, "tel")).toBeNull();
    expect(legacyRedirect(loc("/not-a-token"), known, "tel")).toBeNull();
  });
});

describe("reserved root segments", () => {
  it("no mapped slug collides with a path the site already serves", () => {
    for (const p of registry.projects) expect(RESERVED_ROOT_SEGMENTS, p.slug).not.toContain(p.slug);
  });
});
