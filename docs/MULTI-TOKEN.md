# Multi-token layout

holderdistribution.com is a multi-project platform. Telcoin (TEL) is the first
mapped project, not the brand. This note describes the foundation that lets the
site serve more than one token.

## Pieces

| Piece | Where |
| --- | --- |
| Registry (`slug`, `name`, `ticker`, `default?`) | `config/projects.json` |
| Per-project config (chains, tokens, contracts, staking, supply target, classification paths) | `config/projects/<slug>.json` |
| Browser feeds | `public/data/<slug>/` (served at `/data/<slug>/*`) |
| Live (fresh-from-GitHub) feeds | `/live-data/<slug>/<file>` (`netlify/functions/live-data.mjs`) |
| Node helpers | `scripts/lib/projects.js` |
| Frontend registry and URLs | `src/lib/projects.ts`, `src/lib/dataUrl.ts` (`dataUrl(slug, file)`) |
| Active project | `src/lib/projectStore.ts` + `useProject()` (`src/hooks/useProject.ts`) |
| Header switcher | `src/components/TokenSwitcher.tsx` |

The active project comes from `?token=<slug>`, then localStorage (`ha:project`),
then the registry default. The default slug is never written into the URL, so
existing links stay clean. Every feed hook keys its query by slug.

## TEL and the legacy root (`data.legacyRoot`)

TEL's feeds still live at the root of `public/data/`. About 25 pipeline scripts
and 14 workflows write those paths and read their git history, so moving the
files would mean rewriting the pipeline. `config/projects/tel.json` sets
`data.legacyRoot: true`, and TEL is still served under its slug:

- **Build:** `scripts/prune-dist-data.js` copies the root browser feeds into
  `dist/data/tel/` and keeps the root copies.
- **Dev:** a Vite middleware maps `/data/tel/<file>` to `public/data/<file>`.
- **Live:** `/live-data/tel/<file>` reads `public/data/<file>` from GitHub.

Old URLs keep working. `/data/<file>` and `/live-data/<file>` always mean TEL,
and the live function falls back to `/data/<file>` for legacy URLs and to
`/data/<slug>/<file>` for slug URLs. Once the pipeline writes to
`public/data/tel/`, set `legacyRoot` to `false` and drop the slug from
`LEGACY_ROOT_SLUGS`. No UI change is needed.

Wallet-level data (e.g. `wallet-analysis/`) is still pruned from `dist` and
stays behind the forensics gate.

## Adding the next project

1. Add `{ "slug": "<slug>", "name": "...", "ticker": "..." }` to `config/projects.json`.
   Slugs are lowercase `[a-z0-9-]`.
2. Add `config/projects/<slug>.json` using `tel.json` as the template. Use only
   verified addresses, never guessed ones.
3. Put the browser feeds in `public/data/<slug>/` (same file names as TEL, see
   `BROWSER_DATA_FILES` in `scripts/lib/browserDataFiles.js`).
4. Add the slug to `PROJECT_SLUGS` in `netlify/functions/live-data.mjs`.
   A test fails if it is missing.
5. Run `npm run typecheck && npx vitest run && npm run build`.

The switcher picks the new project up automatically.
