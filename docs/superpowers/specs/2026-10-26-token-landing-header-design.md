# Token landing page + token header — design

- **Date:** 2026-10-26
- **Status:** Approved (approach B); not yet implemented
- **Related:** `docs/MULTI-TOKEN.md`, [Solana chain support design](./2026-10-25-solana-chain-support-design.md)

## Goal

The landing page is home: the visitor picks a token there, then opens that
token's terminal. While a terminal is open, the header shows which token is
being viewed, using the token's CoinGecko coin image. The image is a file
cached in this repo. It is never redrawn or approximated, and the browser never
loads it from CoinGecko.

## Background: how it works today

- `src/App.tsx` routes `/` and `/holders` to the same terminal (`Holders`). Any
  other path renders `NotFound`.
- The active token comes from `?token=<slug>`, then the choice saved in
  localStorage (`src/lib/projectStore.ts`), then the registry default
  (`src/lib/projects.ts`). `src/components/TokenSwitcher.tsx` changes it.
- Mapped tokens are in `config/projects/<slug>.json` (today `tel` and
  `zebec-network`). Feeds are under `public/data/` for TEL and
  `public/data/<slug>/` for other tokens.

## Approach

Approach B: the index route and the slug routes are both real routes, each with
its own title and meta tags. Unknown slugs return a 404, and old URLs redirect
to the new ones.

Rejected options:
- **A**: same screens, but without per-route SEO or redirects.
- **C**: a marketing home page with more copy. That is more than the product
  needs, because the product is the terminal.

## Routing & shell

- `/` is the landing page: a grid of cards, one per mapped token in
  `config/projects/`.
- `/<slug>` is that token's terminal, for example `/tel` and `/zebec-network`.
  The slug sits at the root of the URL (no `/t/` prefix) because that is better
  for SEO.
- A path that is not a mapped slug renders the 404 page (see below).
- Old entry points redirect to `/<slug>` with a client-side `replace`, so they
  don't add a history entry:
  - `/?token=<slug>` → `/<slug>`
  - `/holders` → `/<default slug>`
  - `/holders?token=<slug>` → `/<slug>`
  - If the `?token=` value is not a mapped slug, redirect to `/`.
- `/` with no `?token=` always shows the landing page. It does not auto-redirect
  to the token saved in localStorage.
- Terminal header: the cached CoinGecko image and the token's display name. Both
  link to `/`.
- There is no token switcher on desktop or mobile. To change tokens, the visitor
  goes back to `/`. `TokenSwitcher` is removed from the navigation and the
  terminal. The route slug becomes the only source of the active token. The
  `?token=` and localStorage lookups are kept only for the redirects above.

## Landing cards + feeds

Each card shows:
- the cached CoinGecko image
- the token name
- the ticker
- the **holder count**
- the **retail share of supply**

The whole card links to `/<slug>`.

- The two stats come from feeds that already exist for that slug
  (`holders-lite.json` / the distribution summary feed, at the slug's normal
  data path). No new pipeline, script or feed is added.
- If a feed is missing, returns an error or lacks the field, that stat shows
  "—". The card still renders and can still be clicked. One token's failure
  never blocks the other cards.
- Images: when a token is mapped, its CoinGecko coin image is committed as
  `public/tokens/<slug>.<ext>`, keeping CoinGecko's original format (png or
  jpg). This work adds `public/tokens/tel.*` and
  `public/tokens/zebec-network.*`. Each project config points to its image file.
- CSP: `img-src` stays as it is now (`'self' data: blob:` in `netlify.toml`). No
  CoinGecko or other remote image origin is added.

## SEO, errors, out of scope

- Each route sets its own `<title>` and meta description:
  - landing (`/`): the site name
  - `/<slug>`: "{Name} ({ticker}) holder distribution", for example "Telcoin
    (TEL) holder distribution"
- `/<slug>` sets a self-canonical URL. The sitemap lists `/` and every mapped
  `/<slug>`.
- An unknown slug renders the existing `NotFound` page, which sets `noindex`,
  with a link home to `/`.
- A feed 404 on a card shows "—", as described above.
- Terminals keep today's empty and loading states. The ZBCN Tier Flows panel and
  its missing `tier-outflows` feed are separate work.
- **Out of scope:** paywall and forensics changes, new stats pipelines, a
  desktop token switcher, live CoinGecko fetches of any kind, and the ZBCN
  tier-outflows fix.

## Success criteria

1. Visiting `/` shows TEL and ZBCN cards. Each card has its image, ticker,
   holder count and retail share. A stat shows "—" only when its feed has no
   data.
2. Clicking a card opens `/tel` or `/zebec-network`. That terminal's header
   shows the token image and name, and both link to `/`.
3. No page loads an image from CoinGecko or any other remote origin. Token
   images are served from `public/tokens/`.
4. An unknown slug (for example `/not-a-token`) renders the 404 page with a
   link home.
5. Old URLs (`/?token=<slug>`, `/holders`, `/holders?token=<slug>`) end up on
   the matching `/<slug>`.
