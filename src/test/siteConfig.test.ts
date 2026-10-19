import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("design tokens", () => {
  const css = read("src/index.css");
  const tailwind = read("tailwind.config.ts");

  it("defines every CSS variable that tailwind.config.ts consumes", () => {
    // Regression: the --ha-* (and --radius-md/sm/pill) variables were referenced
    // by Tailwind utilities but never declared, so bg-brand, text-positive,
    // rounded-md etc. silently resolved to nothing.
    // --radix-* are injected at runtime by Radix primitives.
    const used = new Set([...tailwind.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]).filter((v) => !v.startsWith("--radix-")));
    const missing = [...used].filter((v) => !new RegExp(`${v}\\s*:`).test(css));
    expect(missing).toEqual([]);
  });

  it("does not use Tailwind classes that nothing defines", () => {
    const src = ["src/pages/Holders.tsx", "src/App.tsx"].map(read).join("\n");
    expect(src).not.toContain("bg-gradient-telcoin");
  });
});

describe("branding & SEO", () => {
  const html = read("index.html");

  it("has no leftover Telcoin Hub branding in shipped metadata or UI", () => {
    const files = [
      "index.html",
      "public/manifest.json",
      "src/hooks/usePageMeta.ts",
      "src/components/Navigation.tsx",
      "src/pages/Holders.tsx",
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/telcoin\s?hub|telcoinhub\.com/i);
    }
  });

  it("points canonical and OG URLs at holderdistribution.com", () => {
    expect(html).toContain('<link rel="canonical" href="https://holderdistribution.com/">');
    expect(html).toContain('property="og:url" content="https://holderdistribution.com/"');
    expect(read("src/hooks/usePageMeta.ts")).toContain("https://holderdistribution.com");
  });

  it("ships every icon referenced by index.html and the manifest", () => {
    const refs = [...html.matchAll(/href="\/([^"#?]+\.(?:png|ico|json))"/g)].map((m) => m[1]);
    const manifest = JSON.parse(read("public/manifest.json"));
    refs.push(...manifest.icons.map((i: { src: string }) => i.src.replace(/^\//, "")));
    expect(refs.length).toBeGreaterThan(3);
    for (const r of refs) expect(fs.existsSync(path.join(root, "public", r)), r).toBe(true);
  });

  it("sitemap and robots point at the production origin", () => {
    expect(read("public/robots.txt")).toContain("Sitemap: https://holderdistribution.com/sitemap.xml");
    expect(read("public/sitemap.xml")).toContain("<loc>https://holderdistribution.com/</loc>");
  });
});

describe("security headers (netlify.toml)", () => {
  const toml = read("netlify.toml");
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)?.[1] ?? "";

  it("sets a CSP that forbids inline/eval scripts, plugins and framing", () => {
    expect(csp).not.toBe("");
    const script = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
    expect(script).toBe("'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("keeps index.html free of inline event handlers the CSP would block", () => {
    expect(read("index.html")).not.toMatch(/\son[a-z]+="/i);
  });

  it("never exposes secrets through VITE_ variables", () => {
    const decl = read("src/vite-env.d.ts");
    expect(decl).not.toMatch(/VITE_[A-Z_]*(SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE)/);
  });
});
