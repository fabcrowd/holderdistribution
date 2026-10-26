# Token Landing Page + Token Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/` a token picker (one card per mapped token) and `/<slug>` that token's terminal, with a header that shows the token's cached CoinGecko image + name linking home, and no token switcher anywhere.

**Architecture:** React Router gets three real routes: `/` (landing, after a legacy `?token=` redirect check), `/holders` (always redirects) and `/:slug` (a `TokenRoute` gate that 404s unknown slugs and syncs the existing `projectStore` from the URL before the terminal mounts). The route slug becomes the only source of the active token; `?token=` is read only by the pure `legacyRedirect()` helper and localStorage is no longer used. Landing cards reuse the existing `holders-lite.json` feed via `fetchHolderLiteSnapshot(slug)` under the same TanStack query key the terminal already uses, and token images are static files in `public/tokens/`.

**Tech Stack:** React 18 + TypeScript, Vite, react-router-dom v6, TanStack Query v5, Tailwind v3, Vitest (node environment, `renderToStaticMarkup` for component tests), Netlify (`public/_redirects`, `netlify.toml`), `tsx` for `scripts/generate-sitemap.ts`.

**Branch:** `feat/token-landing-header` (cut from `docs/token-landing-header-design`, which is `origin/main` + the design spec).

**Spec:** `docs/superpowers/specs/2026-10-26-token-landing-header-design.md`

## Global Constraints

- `/` is the landing page: a grid of cards, one per mapped token in `config/projects/`.
- `/<slug>` is that token's terminal, e.g. `/tel` and `/zebec-network`. Slug at the root, no `/t/` prefix.
- A path that is not a mapped slug renders the existing `NotFound` page (sets `noindex`) with a link home to `/`.
- Old entry points redirect with a client-side `replace` (no history entry): `/?token=<slug>` → `/<slug>`; `/holders` → `/<default slug>`; `/holders?token=<slug>` → `/<slug>`; a `?token=` value that is not a mapped slug → `/`.
- `/` with no `?token=` always shows the landing page. It never auto-redirects to a saved token.
- Terminal header: the cached CoinGecko image and the token's display name; both link to `/`.
- No token switcher on desktop or mobile. `TokenSwitcher` is removed from the navigation and the terminal. The route slug is the only source of the active token.
- Each card shows: cached CoinGecko image, token name, ticker, **holder count**, **retail share of supply**. The whole card links to `/<slug>`.
- Card stats come only from feeds that already exist (`holders-lite.json` at the slug's normal data path). No new pipeline, script or feed.
- A missing / erroring / field-less feed shows "—" for that stat; the card still renders and is clickable; one token's failure never blocks other cards.
- Images: `public/tokens/<slug>.<ext>`, CoinGecko's original format. This work adds `public/tokens/tel.png` and `public/tokens/zebec-network.jpg`. Each project config points to its image file.
- CSP: `img-src` stays exactly `'self' data: blob:` in `netlify.toml`. No CoinGecko or other remote image origin. No live CoinGecko fetches of any kind.
- Titles: landing = the site name; `/<slug>` = "{Name} ({ticker}) holder distribution", e.g. "Telcoin (TEL) holder distribution".
- `/<slug>` sets a self-canonical URL. The sitemap lists `/` and every mapped `/<slug>`.
- Terminals keep today's empty and loading states.
- Out of scope: paywall/forensics changes, new stats pipelines, a desktop token switcher, live CoinGecko fetches, the ZBCN tier-outflows fix.
- Repo rules (CLAUDE.md): `npm run typecheck`, `npm run lint`, `npm run test` must pass; deploys are manual-only (git push does not build).

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/lib/tokenRoutes.ts` | Create | Pure URL rules: `tokenPath`, `slugFromPath`, `legacyRedirect`, `RESERVED_ROOT_SEGMENTS` |
| `src/lib/tokenRoutes.test.ts` | Create | Tests for the above + "no slug collides with a reserved path" |
| `public/tokens/tel.png`, `public/tokens/zebec-network.jpg` | Create | Cached CoinGecko coin images (binary, committed) |
| `config/projects/tel.json`, `config/projects/zebec-network.json` | Modify | Add `"image"` |
| `src/lib/projects.ts` | Modify | `image?: string` on `ProjectConfig`; drop `resolveInitialSlug`, `withToken`, `PROJECT_STORAGE_KEY` |
| `src/lib/projects.test.ts` | Modify | Image-file test; drop tests of removed helpers |
| `src/components/TokenIdentity.tsx` (+ `.test.tsx`) | Create | Header token mark: image + name, links to `/` |
| `src/components/terminal/TerminalDashboard.tsx` | Modify | Desktop h1 uses `TokenIdentity` |
| `src/components/PageIntro.tsx` | Modify | Mobile h1 uses `TokenIdentity` |
| `src/components/Navigation.tsx` | Modify | Remove the switcher pill |
| `src/components/TokenSwitcher.tsx` (+ `.test.tsx`) | Delete | Switcher is gone |
| `src/components/tokenHeader.test.ts` | Create | Source-level guard: no `TokenSwitcher`, headers use `TokenIdentity` |
| `src/lib/projectStore.ts` (+ `.test.ts`) | Modify / rewrite test | Store initialised from pathname, no URL/localStorage writes |
| `src/hooks/useProject.ts` | Modify | Drop `setProject` |
| `src/lib/landingStats.ts` (+ `.test.ts`) | Create | `cardStats(snapshot)` → formatted holder count + retail share, "—" fallback |
| `src/components/TokenCard.tsx` (+ `.test.tsx`) | Create | One landing card |
| `src/lib/seo.ts` (+ `.test.ts`) | Create | `SITE_TITLE`, `SITE_DESCRIPTION`, `tokenPageTitle`, `tokenPageDescription` |
| `src/pages/Landing.tsx` | Create | `/` page: grid of `TokenCard`s with live stats |
| `src/components/routing/TokenRoute.tsx`, `LegacyRedirect.tsx` (+ `routes.test.tsx`) | Create | Route gate + legacy redirect element |
| `src/App.tsx` | Modify | New route table |
| `src/pages/Holders.tsx` | Modify | Per-token title + self-canonical |
| `src/pages/NotFound.tsx` | Modify | Generic copy, no project dependency |
| `scripts/lib/sitemap.js` (+ `.test.js`) | Create | Pure sitemap builder |
| `scripts/generate-sitemap.ts`, `public/sitemap.xml` | Modify | Emit `/` + every `/<slug>` |
| `public/_redirects` | Modify | Missing `/tokens/*` file → real 404 |
| `src/test/siteConfig.test.ts` | Modify | CSP `img-src` pinned; sitemap lists slugs; no CoinGecko image URLs |
| `docs/MULTI-TOKEN.md`, `CLAUDE.md` | Modify | Document routes, images, no switcher |

---

### Task 1: Pure token-route helpers

**Files:**
- Create: `src/lib/tokenRoutes.ts`
- Test: `src/lib/tokenRoutes.test.ts`

**Interfaces:**
- Consumes: `PROJECTS`, `DEFAULT_PROJECT_SLUG`, `TOKEN_PARAM` from `src/lib/projects.ts` (all exist today).
- Produces:
  - `RESERVED_ROOT_SEGMENTS: readonly string[]`
  - `tokenPath(slug: string): string` → `"/<slug>"`
  - `slugFromPath(pathname: string, known?: readonly string[]): string | null`
  - `type LocLike = { pathname: string; search: string; hash: string }`
  - `legacyRedirect(loc: LocLike, known?: readonly string[], fallback?: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tokenRoutes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tokenRoutes.test.ts`
Expected: FAIL — `Failed to resolve import "./tokenRoutes"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/tokenRoutes.ts`:

```ts
/**
 * URL rules for the token routes (docs/superpowers/specs/2026-10-26-token-landing-header-design.md):
 * `/` is the landing page, `/<slug>` is a token's terminal. `?token=` and
 * `/holders` are legacy entry points; legacyRedirect() maps them onto `/<slug>`.
 * Pure so it can be tested in node.
 */
import { DEFAULT_PROJECT_SLUG, PROJECTS, TOKEN_PARAM } from "@/lib/projects";

/** First path segments the site already serves. A project slug must never be one of these. */
export const RESERVED_ROOT_SEGMENTS: readonly string[] = [
  "holders",
  "data",
  "live-data",
  "assets",
  "tokens",
  "api",
  ".netlify",
  "sitemap.xml",
  "robots.txt",
  "manifest.json",
  "404.html",
  "index.html",
];

const knownSlugs = (): string[] => PROJECTS.map((p) => p.slug);

export const tokenPath = (slug: string): string => `/${slug}`;

/** The mapped slug a pathname names (`/tel`, `/tel/`), else null. Exact match only. */
export const slugFromPath = (pathname: string, known: readonly string[] = knownSlugs()): string | null => {
  const m = /^\/([^/]+)\/?$/.exec(pathname);
  return m && known.includes(m[1]) ? m[1] : null;
};

export type LocLike = { pathname: string; search: string; hash: string };

/**
 * Where a legacy URL should go (client-side replace), or null to render as is.
 *   /?token=<slug>          -> /<slug>
 *   /holders                -> /<fallback>
 *   /holders?token=<slug>   -> /<slug>
 *   unmapped ?token= value  -> /
 * Other query params (range, chain) and the hash are kept on a slug redirect.
 */
export const legacyRedirect = (
  loc: LocLike,
  known: readonly string[] = knownSlugs(),
  fallback: string = DEFAULT_PROJECT_SLUG,
): string | null => {
  const isRoot = loc.pathname === "/";
  const isHolders = /^\/holders\/?$/.test(loc.pathname);
  if (!isRoot && !isHolders) return null;
  const q = new URLSearchParams(loc.search);
  const raw = q.get(TOKEN_PARAM);
  if (isRoot && raw === null) return null;
  q.delete(TOKEN_PARAM);
  const rest = q.toString() ? `?${q.toString()}` : "";
  if (raw === null) return `${tokenPath(fallback)}${rest}${loc.hash}`;
  const token = raw.trim().toLowerCase();
  if (!known.includes(token)) return "/";
  return `${tokenPath(token)}${rest}${loc.hash}`;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tokenRoutes.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tokenRoutes.ts src/lib/tokenRoutes.test.ts
git commit -m "feat(routes): pure token route + legacy redirect helpers"
```

---

### Task 2: Cached CoinGecko images, config `image`, and `TokenIdentity`

**Files:**
- Create: `public/tokens/tel.png`, `public/tokens/zebec-network.jpg` (binary)
- Modify: `config/projects/tel.json`, `config/projects/zebec-network.json` (add `"image"` after `"description"`)
- Modify: `src/lib/projects.ts` (the `ProjectConfig` type)
- Modify: `src/lib/projects.test.ts`
- Create: `src/components/TokenIdentity.tsx`
- Test: `src/components/TokenIdentity.test.tsx`

**Interfaces:**
- Consumes: `useProject()` → `{ slug, project }` (exists).
- Produces:
  - `ProjectConfig.image?: string` — site-absolute path, `"/tokens/<slug>.<png|jpg>"`.
  - `TokenIdentity({ size?: "sm" | "lg"; className?: string })` — `<Link to="/" data-testid="token-identity">` with `<img src={project.image}>` + `<span>{project.name}</span>`.

- [ ] **Step 1: Download the CoinGecko images once (build-time, never at runtime)**

CoinGecko's API returns these exact `image.large` URLs (checked 2026-10-26): TEL is a PNG, ZBCN is a JPEG. Keep the original bytes and format; do not resize, redraw or convert.

```bash
mkdir -p public/tokens
curl -fsSL "https://coin-images.coingecko.com/coins/images/1899/large/telcoin-gray.png" -o public/tokens/tel.png
curl -fsSL "https://coin-images.coingecko.com/coins/images/37052/large/zbcn.jpeg" -o public/tokens/zebec-network.jpg
file public/tokens/tel.png public/tokens/zebec-network.jpg
```

Expected: `tel.png: PNG image data, ...` and `zebec-network.jpg: JPEG image data, ...`. If a URL 404s, re-read it with
`curl -s "https://api.coingecko.com/api/v3/coins/telcoin?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false" | python3 -c "import json,sys;print(json.load(sys.stdin)['image']['large'])"` (id `zebec-network` for ZBCN) and download that URL without its `?…` query.

- [ ] **Step 2: Point each config at its image**

In `config/projects/tel.json`, directly after the `"description": …,` line add:

```json
  "image": "/tokens/tel.png",
```

In `config/projects/zebec-network.json`, directly after the `"description": …,` line add:

```json
  "image": "/tokens/zebec-network.jpg",
```

In `src/lib/projects.ts`, in `export type ProjectConfig = ProjectEntry & {`, add after `description?: string;`:

```ts
  /** Cached CoinGecko coin image, served from public/tokens/ (e.g. "/tokens/tel.png"). Never a remote URL (CSP img-src is 'self'). */
  image?: string;
```

- [ ] **Step 3: Write the failing tests**

Append to `src/lib/projects.test.ts` (add `import fs from "node:fs";` and `import path from "node:path";` at the top):

```ts
describe("token images", () => {
  it("every mapped project has a cached image under public/tokens/<slug>.(png|jpg)", () => {
    for (const p of PROJECTS) {
      const img = getProject(p.slug).image;
      expect(img, p.slug).toMatch(new RegExp(`^/tokens/${p.slug}\\.(png|jpg)$`));
      expect(fs.existsSync(path.resolve(__dirname, "../../public", img!.slice(1))), img).toBe(true);
    }
  });
});
```

Create `src/components/TokenIdentity.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TokenIdentity } from "./TokenIdentity";

const render = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("TokenIdentity", () => {
  it("shows the cached image and the token name, both inside one link home", () => {
    const html = render(<TokenIdentity />);
    expect(html).toContain('data-testid="token-identity"');
    expect(html).toContain('href="/"');
    expect(html).toContain('src="/tokens/tel.png"');
    expect(html).toContain(">Telcoin<");
    expect(html).not.toMatch(/coingecko/i);
    expect(html).not.toContain("<button");
  });
  it("large variant renders a bigger image", () => {
    expect(render(<TokenIdentity size="lg" />)).toContain('width="32"');
    expect(render(<TokenIdentity />)).toContain('width="24"');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/lib/projects.test.ts src/components/TokenIdentity.test.tsx`
Expected: the image test PASSES once Steps 1–2 are done; TokenIdentity FAILS with `Failed to resolve import "./TokenIdentity"`. (If Step 1 was skipped, the image test fails with `expected false to be true`.)

- [ ] **Step 5: Write minimal implementation**

Create `src/components/TokenIdentity.tsx`:

```tsx
import { Link } from "react-router-dom";
import { useProject } from "@/hooks/useProject";

type Props = {
  /** "sm": desktop terminal title bar. "lg": the mobile page heading. */
  size?: "sm" | "lg";
  className?: string;
};

/**
 * Which token is open: its cached CoinGecko image (public/tokens/) and display
 * name. The whole mark links home to the token picker; there is no switcher.
 */
export const TokenIdentity = ({ size = "sm", className = "" }: Props) => {
  const { project } = useProject();
  const px = size === "lg" ? 32 : 24;
  return (
    <Link
      to="/"
      data-testid="token-identity"
      title="All tokens"
      className={`inline-flex items-center gap-1.5 rounded text-primary hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {project.image && (
        <img
          src={project.image}
          alt=""
          width={px}
          height={px}
          decoding="async"
          className={`shrink-0 rounded-full ${size === "lg" ? "h-7 w-7 sm:h-8 sm:w-8" : "h-6 w-6"}`}
        />
      )}
      <span>{project.name}</span>
    </Link>
  );
};

export default TokenIdentity;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/projects.test.ts src/components/TokenIdentity.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/tokens/tel.png public/tokens/zebec-network.jpg config/projects/tel.json config/projects/zebec-network.json src/lib/projects.ts src/lib/projects.test.ts src/components/TokenIdentity.tsx src/components/TokenIdentity.test.tsx
git commit -m "feat(header): cache CoinGecko token images + TokenIdentity mark"
```

---

### Task 3: Replace the token switcher with `TokenIdentity` everywhere

**Files:**
- Modify: `src/components/terminal/TerminalDashboard.tsx:13` (import), `:145` (h1), doc comment above the component
- Modify: `src/components/PageIntro.tsx:4` (import) and `:19` (h1)
- Modify: `src/components/Navigation.tsx:13` (import) and `:62-64` (pill)
- Delete: `src/components/TokenSwitcher.tsx`, `src/components/TokenSwitcher.test.tsx`
- Test: `src/components/tokenHeader.test.ts`

**Interfaces:**
- Consumes: `TokenIdentity` from Task 2.
- Produces: after this task no file imports `TokenSwitcher` (Task 4 relies on that to delete `withToken`).

- [ ] **Step 1: Write the failing test**

Create `src/components/tokenHeader.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");

describe("token header (no switcher)", () => {
  it("the switcher component is gone", () => {
    expect(fs.existsSync(path.resolve(__dirname, "TokenSwitcher.tsx"))).toBe(false);
  });
  it("no navigation or terminal file references TokenSwitcher", () => {
    for (const f of ["Navigation.tsx", "PageIntro.tsx", "terminal/TerminalDashboard.tsx"]) {
      expect(src(f), f).not.toContain("TokenSwitcher");
    }
  });
  it("desktop and mobile headings show TokenIdentity", () => {
    expect(src("terminal/TerminalDashboard.tsx")).toMatch(/<TokenIdentity\b[^>]*\/> Holder Distribution/);
    expect(src("PageIntro.tsx")).toMatch(/<TokenIdentity size="lg"[^>]*\/> holder distribution/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/tokenHeader.test.ts`
Expected: FAIL — `TokenSwitcher.tsx` still exists and the files still contain `TokenSwitcher`.

- [ ] **Step 3: Edit the three components**

`src/components/terminal/TerminalDashboard.tsx` — replace line 13
`import { TokenSwitcher } from "@/components/TokenSwitcher";`
with
`import { TokenIdentity } from "@/components/TokenIdentity";`
and replace the h1 content (line 145)

```tsx
                <TokenSwitcher variant="heading" /> Holder Distribution
```

with

```tsx
                <TokenIdentity /> Holder Distribution
```

In the doc comment above `export const TerminalDashboard`, replace the words `an always-visible "<TICKER> Holder Distribution" h1 whose ticker is the master token switch` with `an always-visible "<image> <Name> Holder Distribution" h1 whose token mark links home to the token picker`.

`src/components/PageIntro.tsx` — replace line 4 with `import { TokenIdentity } from "@/components/TokenIdentity";` and line 19

```tsx
          <TokenSwitcher variant="heading" /> holder distribution
```

with

```tsx
          <TokenIdentity size="lg" className="align-middle" /> holder distribution
```

`src/components/Navigation.tsx` — delete line 13 (`import { TokenSwitcher } from "@/components/TokenSwitcher";`) and replace these lines (62–64):

```tsx
          {/* Master token switch: the only interactive one, at every breakpoint. */}
          <TokenSwitcher variant="pill" className="ml-auto mr-1" />
          <GlossaryDialog />
```

with (the spacer keeps the right-hand controls right-aligned, the job the pill's `ml-auto` used to do):

```tsx
          <span className="ml-auto" aria-hidden="true" />
          <GlossaryDialog />
```

- [ ] **Step 4: Delete the switcher**

```bash
git rm src/components/TokenSwitcher.tsx src/components/TokenSwitcher.test.tsx
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/components && npm run typecheck && rg -n TokenSwitcher src`
Expected: tests PASS; typecheck clean; `rg` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/components/terminal/TerminalDashboard.tsx src/components/PageIntro.tsx src/components/Navigation.tsx src/components/tokenHeader.test.ts
git commit -m "feat(header): drop TokenSwitcher; heading shows token image + name linking home"
```

---

### Task 4: Route slug is the only source of the active token

**Files:**
- Modify: `src/lib/projectStore.ts` (full rewrite below)
- Modify: `src/lib/projectStore.test.ts` (full rewrite below)
- Modify: `src/hooks/useProject.ts` (full rewrite below)
- Modify: `src/lib/projects.ts` (delete `PROJECT_STORAGE_KEY`, `resolveInitialSlug`, `LocLike`, `withToken`; keep `TOKEN_PARAM`)
- Modify: `src/lib/projects.test.ts` (drop the two removed-helper `describe` blocks and their imports)

**Interfaces:**
- Consumes: `slugFromPath` (Task 1), `isProjectSlug`, `DEFAULT_PROJECT_SLUG`.
- Produces (used by Task 6):
  - `getActiveSlug(): string`
  - `subscribeActiveSlug(fn: () => void): () => void`
  - `setActiveSlug(slug: string): boolean` — in-memory only; no URL or localStorage writes.
  - `__resetActiveSlug(slug?: string): void`
  - `useProject(): { slug: string; project: ProjectConfig; projects: readonly ProjectEntry[] }` (no `setProject`).

- [ ] **Step 1: Write the failing test**

Replace all of `src/lib/projectStore.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeWindow = (pathname: string, search = "") => ({
  location: { pathname, search, hash: "" },
  history: { state: null, replaceState: vi.fn(), pushState: vi.fn() },
  addEventListener: vi.fn(),
});

const setItem = vi.fn();
beforeEach(() => {
  vi.resetModules();
  setItem.mockClear();
  vi.stubGlobal("localStorage", { getItem: () => "zebec-network", setItem });
});
afterEach(() => vi.unstubAllGlobals());

describe("active project store (route-driven)", () => {
  it("starts from the /<slug> path, ignoring ?token= and localStorage", async () => {
    vi.stubGlobal("window", fakeWindow("/zebec-network"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("zebec-network");

    vi.resetModules();
    vi.stubGlobal("window", fakeWindow("/", "?token=zebec-network"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("tel");

    vi.resetModules();
    vi.stubGlobal("window", fakeWindow("/not-a-token"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("tel");
  });

  it("setActiveSlug notifies without touching the URL or localStorage", async () => {
    const win = fakeWindow("/tel");
    vi.stubGlobal("window", win);
    const s = await import("./projectStore");
    const seen: string[] = [];
    const off = s.subscribeActiveSlug(() => seen.push(s.getActiveSlug()));
    expect(s.setActiveSlug("zebec-network")).toBe(true);
    expect(s.setActiveSlug("tel")).toBe(true);
    expect(seen).toEqual(["zebec-network", "tel"]);
    expect(win.history.replaceState).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    off();
  });

  it("ignores unknown slugs and no-op switches", async () => {
    vi.stubGlobal("window", fakeWindow("/tel"));
    const s = await import("./projectStore");
    expect(s.setActiveSlug("nope")).toBe(false);
    expect(s.setActiveSlug("tel")).toBe(false);
    expect(s.getActiveSlug()).toBe("tel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/projectStore.test.ts`
Expected: FAIL — the old store resolves `/?token=zebec-network` (and `/not-a-token` via localStorage) to `"zebec-network"` instead of `"tel"`, and `setActiveSlug` calls `replaceState` / `localStorage.setItem`.

- [ ] **Step 3: Rewrite the store, the hook and trim projects.ts**

Replace all of `src/lib/projectStore.ts` with:

```ts
/**
 * The active project. A tiny external store rather than a React context so
 * every feed hook (and non-React helpers like lib/historyNav) can read it
 * without a provider. The URL path is the only source: `/<slug>` sets it at
 * load and TokenRoute (src/components/routing/TokenRoute.tsx) keeps it in sync
 * on navigation. Nothing is written to the URL or localStorage; legacy
 * `?token=` links are handled by lib/tokenRoutes legacyRedirect().
 */
import { DEFAULT_PROJECT_SLUG, isProjectSlug } from "@/lib/projects";
import { slugFromPath } from "@/lib/tokenRoutes";

type Listener = () => void;

const initial = (): string =>
  (typeof window !== "undefined" ? slugFromPath(window.location.pathname) : null) ?? DEFAULT_PROJECT_SLUG;

let current = initial();
const listeners = new Set<Listener>();

export const getActiveSlug = (): string => current;

export const subscribeActiveSlug = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Route sync. Ignores unknown slugs. Returns whether it changed. */
export const setActiveSlug = (slug: string): boolean => {
  if (!isProjectSlug(slug) || slug === current) return false;
  current = slug;
  listeners.forEach((fn) => fn());
  return true;
};

/** Test hook: reset to a given slug. */
export const __resetActiveSlug = (slug: string = DEFAULT_PROJECT_SLUG) => {
  current = slug;
  listeners.forEach((fn) => fn());
};
```

Replace all of `src/hooks/useProject.ts` with:

```ts
import { useSyncExternalStore } from "react";
import { PROJECTS, getProject, type ProjectConfig, type ProjectEntry } from "@/lib/projects";
import { getActiveSlug, subscribeActiveSlug } from "@/lib/projectStore";

export type UseProject = {
  /** Active project slug from the /<slug> route, e.g. "tel". Use it in feed URLs and query keys. */
  slug: string;
  project: ProjectConfig;
  projects: readonly ProjectEntry[];
};

/** Active project for every view (Holders / Distribution / Supply). */
export const useProject = (): UseProject => {
  const slug = useSyncExternalStore(subscribeActiveSlug, getActiveSlug, getActiveSlug);
  return { slug, project: getProject(slug), projects: PROJECTS };
};
```

In `src/lib/projects.ts`, delete everything from `export const PROJECT_STORAGE_KEY = "ha:project";` through the end of the `withToken` function (the `resolveInitialSlug` doc comment + function, `type LocLike`, the `withToken` doc comment + function). Keep `TOKEN_PARAM`, with this comment above it:

```ts
/** Legacy query param (`/?token=<slug>`), read only by lib/tokenRoutes legacyRedirect(). */
export const TOKEN_PARAM = "token";
```

In `getProject`, replace `// Registry wins for the identity fields so the switcher and pages agree.` with `// Registry wins for the identity fields so landing cards and pages agree.`

In `src/lib/projects.test.ts`, remove `resolveInitialSlug,` and `withToken,` from the import list and delete the whole `describe("resolveInitialSlug (?token= > localStorage > default)", …)` and `describe("withToken", …)` blocks.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib && npm run typecheck && rg -n "resolveInitialSlug|withToken|PROJECT_STORAGE_KEY|setProject" src`
Expected: tests PASS, typecheck clean, `rg` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/projectStore.ts src/lib/projectStore.test.ts src/hooks/useProject.ts src/lib/projects.ts src/lib/projects.test.ts
git commit -m "refactor(project): route slug is the only source of the active token"
```

---

### Task 5: Landing page (cards with holder count + retail share)

**Files:**
- Create: `src/lib/landingStats.ts`, test `src/lib/landingStats.test.ts`
- Create: `src/lib/seo.ts`, test `src/lib/seo.test.ts`
- Create: `src/components/TokenCard.tsx`, test `src/components/TokenCard.test.tsx`
- Create: `src/pages/Landing.tsx`

**Interfaces:**
- Consumes: `fetchHolderLiteSnapshot(slug): Promise<HolderLiteSnapshot>` and type `HolderLiteSnapshot` from `src/hooks/useHolderSnapshot.ts` (exist); `PROJECTS`, `getProject` (exist); `tokenPath` (Task 1); `usePageMeta` (exists).
- Produces:
  - `DASH = "—"`; `type CardStats = { holders: string; retailShare: string }`; `cardStats(snap: HolderLiteSnapshot | null | undefined): CardStats`
  - `SITE_TITLE`, `SITE_DESCRIPTION`, `tokenPageTitle(p: { name: string; ticker: string }): string`, `tokenPageDescription(p: { ticker: string }): string` (Task 7 uses the last two)
  - `TokenCard(props: { slug: string; name: string; ticker: string; image?: string; stats: CardStats | null })` (`stats === null` = loading)
  - `Landing` default export (Task 6 routes it)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/landingStats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { DASH, cardStats } from "./landingStats";

const snap = (holderCount: unknown, totalBalance: unknown, totalSupply: unknown) =>
  ({ totals: { totalSupply }, views: { combined: { metrics: { holderCount, totalBalance } } } }) as unknown as HolderLiteSnapshot;

describe("cardStats", () => {
  it("formats holder count and retail share of total supply", () => {
    expect(cardStats(snap(102130, 66_323_619_610.4, 100_000_000_000))).toEqual({ holders: "102,130", retailShare: "66.3%" });
  });
  it("shows a dash per missing stat, independently", () => {
    expect(cardStats(undefined)).toEqual({ holders: DASH, retailShare: DASH });
    expect(cardStats(null)).toEqual({ holders: DASH, retailShare: DASH });
    expect(cardStats(snap(5, undefined, 100))).toEqual({ holders: "5", retailShare: DASH });
    expect(cardStats(snap(undefined, 50, 100))).toEqual({ holders: DASH, retailShare: "50.0%" });
    expect(cardStats(snap(5, 50, 0))).toEqual({ holders: "5", retailShare: DASH });
    expect(cardStats({} as HolderLiteSnapshot)).toEqual({ holders: DASH, retailShare: DASH });
  });
});
```

Create `src/lib/seo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SITE_TITLE, tokenPageDescription, tokenPageTitle } from "./seo";

describe("seo copy", () => {
  it("token title is '{Name} ({ticker}) holder distribution'", () => {
    expect(tokenPageTitle({ name: "Telcoin", ticker: "TEL" })).toBe("Telcoin (TEL) holder distribution");
    expect(tokenPageTitle({ name: "Zebec Network", ticker: "ZBCN" })).toBe("Zebec Network (ZBCN) holder distribution");
  });
  it("landing title is the site name (same as index.html)", () => {
    expect(SITE_TITLE).toBe("Holder Distribution | Token Holder Analytics & Supply Data");
  });
  it("token description names the ticker", () => {
    expect(tokenPageDescription({ ticker: "ZBCN" })).toContain("ZBCN");
  });
});
```

Create `src/components/TokenCard.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TokenCard } from "./TokenCard";

const render = (stats: { holders: string; retailShare: string } | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <TokenCard slug="zebec-network" name="Zebec Network" ticker="ZBCN" image="/tokens/zebec-network.jpg" stats={stats} />
    </MemoryRouter>,
  );

describe("TokenCard", () => {
  it("is one link to /<slug> with image, name, ticker and both stats", () => {
    const html = render({ holders: "111,469", retailShare: "38.6%" });
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/zebec-network"');
    expect(html).toContain('src="/tokens/zebec-network.jpg"');
    expect(html).toContain(">Zebec Network<");
    expect(html).toContain(">ZBCN<");
    expect(html).toContain(">111,469<");
    expect(html).toContain(">38.6%<");
    expect(html).toContain("Holders");
    expect(html).toContain("Retail share of supply");
  });
  it("still renders and links when stats are dashes", () => {
    const html = render({ holders: "—", retailShare: "—" });
    expect(html).toContain('href="/zebec-network"');
    expect(html.match(/>—</g)).toHaveLength(2);
  });
  it("shows a loading placeholder while stats are pending", () => {
    expect(render(null)).toContain('data-loading="true"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/landingStats.test.ts src/lib/seo.test.ts src/components/TokenCard.test.tsx`
Expected: FAIL — unresolved imports `./landingStats`, `./seo`, `./TokenCard`.

- [ ] **Step 3: Implement the helpers and the card**

Create `src/lib/landingStats.ts`:

```ts
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

export const DASH = "—";

export type CardStats = { holders: string; retailShare: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Landing-card stats from a token's existing holders-lite.json: holder count
 * (views.combined.metrics.holderCount) and retail share of supply
 * (views.combined.metrics.totalBalance / totals.totalSupply, the same inputs as
 * the terminal's "Retail Held" tile). Each stat falls back to "—" on its own.
 */
export const cardStats = (snap: HolderLiteSnapshot | null | undefined): CardStats => {
  const m = snap?.views?.combined?.metrics;
  const count = num(m?.holderCount);
  const held = num(m?.totalBalance);
  const supply = num(snap?.totals?.totalSupply);
  return {
    holders: count === null ? DASH : new Intl.NumberFormat("en-US").format(count),
    retailShare: held === null || supply === null || supply <= 0 ? DASH : `${((held / supply) * 100).toFixed(1)}%`,
  };
};
```

Create `src/lib/seo.ts`:

```ts
/** Page titles / descriptions for the landing page and token routes. */

/** The site name, as already used by index.html's <title>. */
export const SITE_TITLE = "Holder Distribution | Token Holder Analytics & Supply Data";

export const SITE_DESCRIPTION =
  "Real, on-chain holder distribution, supply breakdown, and exchange flow data for crypto tokens — a source of truth for the community, not the project team.";

export const tokenPageTitle = (p: { name: string; ticker: string }): string => `${p.name} (${p.ticker}) holder distribution`;

export const tokenPageDescription = (p: { ticker: string }): string =>
  `${p.ticker} tokenomics: circulating supply breakdown, holder distribution and tiers, exchange flows, and historical growth from real-time on-chain data.`;
```

Create `src/components/TokenCard.tsx`:

```tsx
import { Link } from "react-router-dom";
import type { CardStats } from "@/lib/landingStats";
import { tokenPath } from "@/lib/tokenRoutes";

type Props = {
  slug: string;
  name: string;
  ticker: string;
  /** Cached image path (public/tokens/). */
  image?: string;
  /** null while the feed is loading. */
  stats: CardStats | null;
};

const Stat = ({ label, value }: { label: string; value: string | null }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    {value === null ? (
      <dd data-loading="true" className="h-5 w-16 rounded bg-muted/70 animate-pulse" aria-label="Loading" />
    ) : (
      <dd className="font-mono text-base font-semibold tabular-nums text-foreground">{value}</dd>
    )}
  </div>
);

/** One landing card. The whole card is a single link to the token's terminal. */
export const TokenCard = ({ slug, name, ticker, image, stats }: Props) => (
  <Link
    to={tokenPath(slug)}
    data-testid={`token-card-${slug}`}
    className="group flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <div className="flex items-center gap-3">
      {image && <img src={image} alt="" width={40} height={40} decoding="async" className="h-10 w-10 shrink-0 rounded-full" />}
      <div className="min-w-0">
        <h2 className="truncate text-lg font-bold text-foreground group-hover:text-primary">{name}</h2>
        <p className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">{ticker}</p>
      </div>
    </div>
    <dl className="grid grid-cols-2 gap-3">
      <Stat label="Holders" value={stats ? stats.holders : null} />
      <Stat label="Retail share of supply" value={stats ? stats.retailShare : null} />
    </dl>
  </Link>
);

export default TokenCard;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/landingStats.test.ts src/lib/seo.test.ts src/components/TokenCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create the landing page**

Create `src/pages/Landing.tsx`:

```tsx
import { useQueries } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { TokenCard } from "@/components/TokenCard";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fetchHolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { PROJECTS, getProject } from "@/lib/projects";
import { cardStats } from "@/lib/landingStats";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/seo";

/**
 * Home: pick a token, then open its terminal. One card per mapped project; the
 * stats come from each token's existing holders-lite.json under the same query
 * key the terminal uses (["holder-lite", slug]), so opening a card reuses the
 * cached snapshot. Each card's query fails on its own and shows "—".
 */
const Landing = () => {
  usePageMeta({ title: SITE_TITLE, description: SITE_DESCRIPTION, canonicalPath: "/" });

  const queries = useQueries({
    queries: PROJECTS.map((p) => ({
      queryKey: ["holder-lite", p.slug],
      queryFn: () => fetchHolderLiteSnapshot(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main id="main-content" className="mx-auto max-w-7xl px-4 py-8 sm:py-12">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">Token holder distribution</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          On-chain holder counts, distribution and supply for each mapped token. Pick a token to open its terminal.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Tokens">
          {PROJECTS.map((p, i) => {
            const q = queries[i];
            const project = getProject(p.slug);
            const stats = q.isPending ? null : cardStats(q.isError ? null : q.data);
            return (
              <li key={p.slug}>
                <TokenCard slug={p.slug} name={project.name} ticker={project.ticker} image={project.image} stats={stats} />
              </li>
            );
          })}
        </ul>
      </main>
      <Footer />
    </div>
  );
};

export default Landing;
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. (`Landing` is not routed yet; Task 6 wires it.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/landingStats.ts src/lib/landingStats.test.ts src/lib/seo.ts src/lib/seo.test.ts src/components/TokenCard.tsx src/components/TokenCard.test.tsx src/pages/Landing.tsx
git commit -m "feat(landing): token cards with holder count + retail share from holders-lite"
```

---

### Task 6: Route table — landing, `/:slug` gate, legacy redirects, 404

**Files:**
- Create: `src/components/routing/TokenRoute.tsx`
- Create: `src/components/routing/LegacyRedirect.tsx`
- Test: `src/components/routing/routes.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `legacyRedirect` (Task 1); `getActiveSlug`, `setActiveSlug`, `subscribeActiveSlug`, `__resetActiveSlug` (Task 4); `isProjectSlug`; `Landing` (Task 5); `Holders`, `NotFound` (exist).
- Produces:
  - `TokenRoute({ children: ReactNode; notFound: ReactNode })` — reads `:slug`; unknown → `notFound`; known → syncs the store, renders `children` keyed by slug once the store matches.
  - `LegacyRedirect({ children?: ReactNode })` — `<Navigate replace>` when `legacyRedirect(location)` returns a URL, else `children`.

- [ ] **Step 1: Write the failing test**

Create `src/components/routing/routes.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/routing/routes.test.tsx`
Expected: FAIL — unresolved `./TokenRoute` / `./LegacyRedirect`.

- [ ] **Step 3: Implement the route elements**

Create `src/components/routing/TokenRoute.tsx`:

```tsx
import { Fragment, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { isProjectSlug } from "@/lib/projects";
import { getActiveSlug, setActiveSlug, subscribeActiveSlug } from "@/lib/projectStore";

type Props = { children: ReactNode; notFound: ReactNode };

/**
 * `/:slug` gate. Unknown slug → the 404 page. Known slug → sync the active
 * project store (before paint), then render the terminal keyed by slug so all
 * terminal state resets when the token changes. Until the store matches (one
 * layout-effect tick on a client-side slug change) it renders nothing, so no
 * feed hook ever fetches the previous token's data under the new URL.
 */
export const TokenRoute = ({ children, notFound }: Props) => {
  const { slug = "" } = useParams();
  const known = isProjectSlug(slug);
  const active = useSyncExternalStore(subscribeActiveSlug, getActiveSlug, getActiveSlug);
  useLayoutEffect(() => {
    if (known) setActiveSlug(slug);
  }, [known, slug]);
  if (!known) return <>{notFound}</>;
  if (active !== slug) return null;
  return <Fragment key={slug}>{children}</Fragment>;
};

export default TokenRoute;
```

Create `src/components/routing/LegacyRedirect.tsx`:

```tsx
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { legacyRedirect } from "@/lib/tokenRoutes";

/** Old entry points (/?token=, /holders) → /<slug> with a history replace. */
export const LegacyRedirect = ({ children = null }: { children?: ReactNode }) => {
  const location = useLocation();
  const to = legacyRedirect(location);
  if (to) return <Navigate to={to} replace />;
  return <>{children}</>;
};

export default LegacyRedirect;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/routing/routes.test.tsx`
Expected: PASS. (React may log `useLayoutEffect does nothing on the server`; harmless in this static-render test.)

- [ ] **Step 5: Wire the route table**

In `src/App.tsx`, add with the other imports at the top:

```tsx
import { TokenRoute } from "@/components/routing/TokenRoute";
import { LegacyRedirect } from "@/components/routing/LegacyRedirect";
```

Replace the comment + lazy imports:

```tsx
// Single-route extraction of the original hub's Holders/Tokenomics section.
// The full hub had many pages; this repo deploys just this one, so there is
// only one lazy-loaded route rather than the original app's route table.
const Holders = lazy(() => import("./pages/Holders"));
const NotFound = lazy(() => import("./pages/NotFound"));
```

with:

```tsx
// "/" is the token picker; "/<slug>" is that token's terminal
// (docs/superpowers/specs/2026-10-26-token-landing-header-design.md).
// "/holders" and "/?token=" are legacy entry points that redirect.
const Landing = lazy(() => import("./pages/Landing"));
const Holders = lazy(() => import("./pages/Holders"));
const NotFound = lazy(() => import("./pages/NotFound"));
```

Replace the `<Routes>` block:

```tsx
            <Routes>
              <Route path="/" element={<Holders />} />
              <Route path="/holders" element={<Holders />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
```

with:

```tsx
            <Routes>
              <Route path="/" element={<LegacyRedirect><Landing /></LegacyRedirect>} />
              <Route path="/holders" element={<LegacyRedirect />} />
              <Route path="/:slug" element={<TokenRoute notFound={<NotFound />}><Holders /></TokenRoute>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
```

- [ ] **Step 6: Typecheck + full tests**

Run: `npm run typecheck && npm run test`
Expected: clean / all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/routing/TokenRoute.tsx src/components/routing/LegacyRedirect.tsx src/components/routing/routes.test.tsx src/App.tsx
git commit -m "feat(routes): / landing, /:slug terminal, legacy ?token= and /holders redirects, 404 unknown slugs"
```

---

### Task 7: SEO — per-token title + canonical, sitemap, 404 copy

**Files:**
- Modify: `src/pages/Holders.tsx:38` (`VIEW_TITLES`), `:92-94` (stale route comment), `:172-180` (`usePageMeta`)
- Modify: `src/pages/NotFound.tsx`
- Create: `scripts/lib/sitemap.js`, test `scripts/lib/sitemap.test.js`
- Modify: `scripts/generate-sitemap.ts`
- Modify (regenerated): `public/sitemap.xml`
- Modify: `src/test/siteConfig.test.ts`

**Interfaces:**
- Consumes: `tokenPageTitle`, `tokenPageDescription` (Task 5); `tokenPath` (Task 1); `loadRegistry` from `scripts/lib/projects.js` (exists).
- Produces: `buildSitemap({ baseUrl: string, slugs: string[], today: string }): string`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/sitemap.test.js`:

```js
import { describe, expect, it } from "vitest";
import { buildSitemap } from "./sitemap.js";

describe("buildSitemap", () => {
  const xml = buildSitemap({ baseUrl: "https://holderdistribution.com", slugs: ["tel", "zebec-network"], today: "2026-10-26" });
  it("lists the landing page and every token route", () => {
    expect(xml).toContain("<loc>https://holderdistribution.com/</loc>");
    expect(xml).toContain("<loc>https://holderdistribution.com/tel</loc>");
    expect(xml).toContain("<loc>https://holderdistribution.com/zebec-network</loc>");
    expect(xml.match(/<url>/g)).toHaveLength(3);
    expect(xml).toContain("<lastmod>2026-10-26</lastmod>");
  });
  it("does not list legacy URLs", () => {
    expect(xml).not.toContain("/holders");
    expect(xml).not.toContain("?token=");
  });
});
```

In `src/test/siteConfig.test.ts`, inside `describe("branding & SEO", …)`, after the `"sitemap and robots point at the production origin"` test, add:

```ts
  it("sitemap lists every mapped token route", () => {
    const sitemap = read("public/sitemap.xml");
    const registry = JSON.parse(read("config/projects.json"));
    for (const p of registry.projects) expect(sitemap).toContain(`<loc>https://holderdistribution.com/${p.slug}</loc>`);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/lib/sitemap.test.js src/test/siteConfig.test.ts`
Expected: FAIL — `./sitemap.js` missing; `public/sitemap.xml` has no `/tel` entry.

- [ ] **Step 3: Implement the sitemap builder and generator**

Create `scripts/lib/sitemap.js`:

```js
/** Sitemap for holderdistribution.com: the landing page plus one /<slug> per mapped token. */
export function buildSitemap({ baseUrl, slugs, today }) {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (loc, priority) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${priority}</priority>
  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[url(`${base}/`, "1.0"), ...slugs.map((s) => url(`${base}/${s}`, "0.9"))].join("\n")}
</urlset>
`;
}
```

Replace all of `scripts/generate-sitemap.ts` with:

```ts
import { writeFileSync } from "fs";
import { resolve } from "path";
import { buildSitemap } from "./lib/sitemap.js";
import { loadRegistry } from "./lib/projects.js";

// Landing page + one /<slug> per mapped token (config/projects.json).
const BASE_URL = "https://holderdistribution.com";

const slugs = loadRegistry(process.cwd()).map((p: { slug: string }) => p.slug);
const xml = buildSitemap({ baseUrl: BASE_URL, slugs, today: new Date().toISOString().split("T")[0] });

const outputPath = resolve(process.cwd(), "public/sitemap.xml");
writeFileSync(outputPath, xml);
console.log(`Sitemap generated at ${outputPath} (${slugs.length + 1} URLs)`);
```

Regenerate: `npx tsx scripts/generate-sitemap.ts`
Expected: `Sitemap generated at …/public/sitemap.xml (3 URLs)`.

- [ ] **Step 4: Per-token title + self-canonical in the terminal**

In `src/pages/Holders.tsx`:

1. Delete line 38: `const VIEW_TITLES: Record<string, string> = { holders: "Holders", distribution: "Distribution", supply: "Supply" };`
2. Add to the imports: `import { tokenPageDescription, tokenPageTitle } from "@/lib/seo";` and `import { tokenPath } from "@/lib/tokenRoutes";`
3. Replace the three comment lines at the top of `const Holders = () => {` that start `// Route stays /holders deliberately` with `// Mounted at /<slug> by TokenRoute; /holders redirects there (lib/tokenRoutes).`
4. Replace (around lines 172–180):

```tsx
  const { project } = useProject();

  // Per-view title so tabs, history and bookmarks say which view they are.
  // Canonical stays "/": the views are one page, not separate documents.
  usePageMeta({
    title: `${VIEW_TITLES[activeTab]} · ${project.ticker} Holder Distribution | Holder Analytics`,
    description: `${project.ticker} tokenomics: circulating supply breakdown, holder distribution and tiers, exchange flows, and historical growth from real-time on-chain data.`,
    canonicalPath: '/',
  });
```

with:

```tsx
  const { slug, project } = useProject();

  // One document per token: "/<slug>" is self-canonical and its title names
  // the token. The views (#holders, #distribution, #supply) are the same page.
  usePageMeta({
    title: tokenPageTitle(project),
    description: tokenPageDescription(project),
    canonicalPath: tokenPath(slug),
  });
```

- [ ] **Step 5: Generic 404 copy (no project dependency)**

In `src/pages/NotFound.tsx`: delete `import { useProjectCopy } from "@/hooks/useProjectCopy";` and `const { ticker } = useProjectCopy();`. Replace

```tsx
        <p className="mt-3 text-muted-foreground">There&apos;s nothing at this address. The {ticker} holder dashboard is on the home page.</p>
```

with

```tsx
        <p className="mt-3 text-muted-foreground">There&apos;s nothing at this address. Pick a token on the home page.</p>
```

and the button text `Go to the dashboard` with `Go to home`. Keep the `noindex, nofollow` effect, `to="/"` and `data-testid="not-found"` unchanged.

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `npx vitest run scripts/lib/sitemap.test.js src/test/siteConfig.test.ts && npm run typecheck && npm run lint`
Expected: PASS / clean. (`activeTab` is still used by the tabs, so removing it from the title leaves no unused variable.)

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/sitemap.js scripts/lib/sitemap.test.js scripts/generate-sitemap.ts public/sitemap.xml src/pages/Holders.tsx src/pages/NotFound.tsx src/test/siteConfig.test.ts
git commit -m "feat(seo): per-token title + self-canonical, sitemap lists token routes, generic 404"
```

---

### Task 8: CSP guard, `/tokens/*` 404, docs

**Files:**
- Modify: `public/_redirects`
- Modify: `src/test/siteConfig.test.ts`
- Modify: `docs/MULTI-TOKEN.md` (Pieces table, active-project paragraph, "Adding the next project", zebec-network section)
- Modify: `CLAUDE.md` (project-structure lines for `App.tsx` / `pages/`)

**Interfaces:**
- Consumes: nothing new. `netlify.toml` is **not** edited.
- Produces: tests that pin `img-src 'self' data: blob:` and forbid remote CoinGecko image URLs.

- [ ] **Step 1: Write the failing test**

In `src/test/siteConfig.test.ts`, inside `describe("security headers (netlify.toml)", …)`, add:

```ts
  it("img-src stays same-origin only (token images are cached in public/tokens/)", () => {
    expect(/img-src ([^;]+)/.exec(csp)?.[1]).toBe("'self' data: blob:");
  });

  it("no source file or project config loads an image from CoinGecko", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    const files = [...walk("src"), ...walk("config/projects")].filter((f) => /\.(tsx?|json|css)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const f of files) expect(read(f), f).not.toMatch(/coin-images\.coingecko\.com|assets\.coingecko\.com/);
  });

  it("a missing /tokens/* file is a real 404, not the SPA shell", () => {
    expect(read("public/_redirects")).toMatch(/^\/tokens\/\*\s+\/404\.html\s+404$/m);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/siteConfig.test.ts`
Expected: the CSP and CoinGecko guards PASS already (they lock in current behaviour); the `/tokens/*` test FAILS.

- [ ] **Step 3: Add the redirect rule**

In `public/_redirects`, directly after the line `/data/*    /404.html  404` add:

```
/tokens/*  /404.html  404
```

- [ ] **Step 4: Update docs**

`docs/MULTI-TOKEN.md`, Pieces table — replace the row ``| Header switcher | `src/components/TokenSwitcher.tsx` |`` with:

```
| Routes (`/` landing, `/<slug>` terminal, legacy redirects) | `src/App.tsx`, `src/lib/tokenRoutes.ts`, `src/components/routing/` |
| Landing cards | `src/pages/Landing.tsx`, `src/components/TokenCard.tsx`, `src/lib/landingStats.ts` |
| Token image + header mark | `public/tokens/<slug>.<png or jpg>` (config `image`), `src/components/TokenIdentity.tsx` |
```

Replace the paragraph that starts ``The active project comes from `?token=<slug>`, then localStorage`` (3 lines) with:

```
The active project is the URL path: `/<slug>` (e.g. `/tel`, `/zebec-network`).
`/` is the landing page (one card per project) and never auto-redirects.
Legacy `/?token=<slug>`, `/holders` and `/holders?token=<slug>` redirect to
`/<slug>` (`legacyRedirect` in `src/lib/tokenRoutes.ts`); an unknown slug is a
404. There is no token switcher: the header's token image + name link home.
Every feed hook keys its query by slug. A slug must not be one of
`RESERVED_ROOT_SEGMENTS` (a test enforces it).
```

In "## Adding the next project", insert this as the new step 3 and renumber the following steps (old 3–7 become 4–8):

```
3. Cache the token's CoinGecko coin image (build time only, never fetched by
   the browser): read `image.large` from
   `https://api.coingecko.com/api/v3/coins/<coingecko-id>`, download it without
   its `?…` query to `public/tokens/<slug>.<png|jpg>` in its original format,
   and set `"image": "/tokens/<slug>.<ext>"` in `config/projects/<slug>.json`.
   CSP `img-src` stays `'self'`. Then run `npx tsx scripts/generate-sitemap.ts`
   so the sitemap lists `/<slug>`.
```

Replace the closing line `The switcher picks the new project up automatically.` with `The landing page and the sitemap pick the new project up automatically.`

In the `## zebec-network (Solana)` section, replace `` `?token=zebec-network` `` with `` `/zebec-network` ``.

`CLAUDE.md` — replace the line
`│   ├── App.tsx               — router; single route: / and /holders → Holders page`
with
`│   ├── App.tsx               — router: / landing (token picker), /<slug> terminal (Holders), legacy /holders + ?token= redirect`
and in the `pages/` block add `│   │   ├── Landing.tsx       — token picker cards` directly above the `Holders.tsx` line.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/test/siteConfig.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/_redirects src/test/siteConfig.test.ts docs/MULTI-TOKEN.md CLAUDE.md
git commit -m "chore: pin CSP img-src, 404 missing token images, document token routes"
```

---

### Task 9: Full verification against the spec's success criteria, then ship

**Files:** none (verification only; fix-forward in the task that owns a failure).

- [ ] **Step 1: Static checks**

Run: `npm ci && npm run typecheck && npm run lint && npm run test && npm run build && ls dist/tokens dist/sitemap.xml`
Expected: all clean; `dist/tokens/tel.png`, `dist/tokens/zebec-network.jpg` and `dist/sitemap.xml` exist. If `scripts/prune-dist-data.js` (postbuild) removed `dist/tokens`, stop and fix it so it only touches `dist/data`.

- [ ] **Step 2: Preview and walk the success criteria**

Run `npx vite preview --port 4173` in the background, then in a browser:

1. `http://localhost:4173/` → TEL and ZBCN cards, each with image, name, ticker, a holder count and a retail share ("—" only if that feed is missing). Title is `Holder Distribution | Token Holder Analytics & Supply Data`.
2. Click the TEL card → URL `/tel`; the header (desktop ≥1280px and a phone width) shows the TEL image + "Telcoin"; clicking it goes to `/`. Same for `/zebec-network`. Title `Telcoin (TEL) holder distribution`; `<link rel="canonical">` is `https://holderdistribution.com/tel`.
3. DevTools → Network → Img: every image request is same-origin; none go to `coingecko.com`. Console shows no CSP violation.
4. `/not-a-token` → 404 page, `<meta name="robots" content="noindex, nofollow">`, "Go to home" links to `/`.
5. `/?token=zebec-network` → `/zebec-network`; `/holders` → `/tel`; `/holders?token=zebec-network#supply` → `/zebec-network#supply` (Supply view open); `/?token=nope` → `/`. Back from each returns to the page before the legacy URL (replace, no extra history entry).
6. On `/zebec-network`, go back to `/`, open TEL: the terminal shows TEL numbers (no ZBCN figures flash).
7. No token switcher pill or dropdown at any width.

- [ ] **Step 3: Ship (CLAUDE.md: deploys are manual-only)**

```bash
git push -u origin feat/token-landing-header
gh pr create --base main --title "Token landing page + token header (/ picker, /<slug> terminals)" --body "Implements docs/superpowers/specs/2026-10-26-token-landing-header-design.md per docs/superpowers/plans/2026-10-26-token-landing-header.md."
```

After review and merge to `main`, trigger the production deploy manually (Netlify dashboard → Deploys → Trigger deploy; git pushes never build). Then repeat Step 2 checks 1–5 against `https://holderdistribution.com`.

---

## Self-review (against the spec)

| Spec requirement | Task |
| --- | --- |
| `/` landing grid, one card per mapped token | 5 (Landing), 6 (route) |
| `/<slug>` terminal, slug at root | 1 (`tokenPath`), 6 (`/:slug` + `TokenRoute`) |
| Unknown slug → existing `NotFound` (noindex) with link home | 6 (gate), 7 (copy; noindex kept) |
| Redirects `/?token=`, `/holders`, `/holders?token=`, unmapped token → `/`, all via replace | 1 (`legacyRedirect`), 6 (`<Navigate replace>`) |
| `/` never auto-redirects to the saved token | 1 (test), 4 (localStorage no longer read) |
| Header: cached image + display name, both link `/` | 2 (`TokenIdentity`), 3 (desktop + mobile) |
| No switcher on desktop/mobile; `TokenSwitcher` removed from nav + terminal | 3 |
| Route slug is the only source of the active token | 4 (store), 6 (`TokenRoute` sync) |
| Card: image, name, ticker, holder count, retail share; whole card is the link | 5 (`TokenCard`, `cardStats`) |
| Stats from existing feeds only; "—" per stat on failure; cards independent | 5 (`holders-lite.json` via `useQueries`, per-query error) |
| Images `public/tokens/<slug>.<ext>`, original format, tel + zebec-network, config points to file | 2 |
| CSP `img-src` unchanged; no remote image origin | 8 (pinned test; `netlify.toml` untouched) |
| Titles: landing = site name; token = "{Name} ({ticker}) holder distribution" | 5 (`seo.ts`), 7 (Holders) |
| Self-canonical `/<slug>`; sitemap `/` + every `/<slug>` | 7 |
| Terminals keep today's empty/loading states | No task changes terminal widgets |
| Out of scope respected (paywall, pipelines, switcher, live CG, tier-outflows) | No task touches them |

Decisions where the spec was silent (flag in the PR description):
- Landing title "the site name" reuses index.html's existing `<title>` (`Holder Distribution | Token Holder Analytics & Supply Data`).
- Slug matching is exact-case (`/TEL` is a 404) so there is one URL per token.
- A legacy redirect to a slug keeps other query params (`range`, `chain`) and the hash, so old shared deep links open the same view; an unmapped `?token=` goes to plain `/`.
- localStorage (`ha:project`) is dropped entirely: with `/` never auto-redirecting, none of the spec's redirects read it.
- Retail share = `views.combined.metrics.totalBalance / totals.totalSupply` (the terminal's own "Retail Held" inputs), one decimal; holder count is the full number with thousands separators.
- A missing `/tokens/*` file is a real 404 (matches the existing `/data/*` rule).
- On `/` the shared `Navigation` (glossary) and `Footer` read the store's default project (TEL) for their copy, exactly as they do today; making them token-neutral on the landing page is not in the spec and is left for a follow-up if the owner wants it.
