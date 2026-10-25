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
| Project-driven copy | `src/lib/projectCopy.ts`, `useProjectCopy()` (`src/hooks/useProjectCopy.ts`), `src/lib/glossary.ts` |
| Pipeline `--project` | `parseProjectArg` / `pipelineProject` in `scripts/lib/projects.js` |

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

## Copy (labels, intros, glossary)

Widget text is written once as a generic template with placeholders
`{ticker}`, `{name}`, `{chains}` and `{supply}`, filled from the active
project (`useProjectCopy()` → `t(template)` / `text(id, template)`). Chains are
joined from `chains[].name`; supply is `supplyTarget` formatted (e.g. `100B`).

A project that needs different wording overrides it in its own config, so a
new project works with no `copy` section at all:

- `copy.glossary.<termId>`: `{ "term"?, "definition"? }` for the glossary
  (`retail`, `legacy-v3`, `supply`, `cex`, `dex`, `escrow`, `staked`, `tier`,
  `snapshot`, `reclassified`). `legacy-v3` only shows for projects with more
  than one token generation.
- `copy.text.<id>`: replaces one widget string (ids are the first argument of
  `text(...)`, e.g. `holders.cex.info`, `staking.intro`). Some also take a
  runtime value the widget fills itself: `{amount}` (`supply.holdings.description`)
  and `{treasuryNow}` (`supply.coingecko.note`).
- Entity slots (Supply view): every project gets the same foundation /
  team panels, treasury chart lines and footer disclaimer. Name them with
  `copy.text` `entity.association`, `entity.associationShort`,
  `entity.holdings`, `entity.holdingsShort` (generic: "{name}
  Foundation-Controlled Safes" / "Foundation" / "{name} Team Wallets" /
  "Team"), plus `supply.association.description`, `supply.holdings.description`,
  `supply.escrow.description`, `treasury.series.council`,
  `treasury.history.info`, `footer.affiliation`.
- `copy.methodology.<section>`: `{ "how"?, "verify"?, "links"? }` replaces a
  methodology hover card (`src/lib/methodology.ts`, sections in
  `METHODOLOGY_KEYS`). Without it the generic text is used and links are
  derived from `chains[].tokens` and `staking[]`. Override hrefs can use
  `{token:<chainKey>:<generation>}` and `{explorer:<chainKey>}`.

TEL's content (Association vs Holdings, KuCoin/BitGo/Anchorage, the CoinGecko
trace, legacy→v3 methodology, staking module notes) lives in
`config/projects/tel.json` under `copy`, and renders exactly as before.
`src/lib/projectCopyCoverage.test.ts` fails if a bare `TEL`, `Telcoin`,
`Anchorage`, `BitGo` or `KuCoin` reappears in the generalized files.
Still TEL-specific on purpose: the gated forensics views (disposition ledger,
P&L, wallet flows, burn forecast, forensics write-ups) and the v3
StakingModule constants in `src/lib/staking.ts` (only TEL has that module).

## Pipeline: `--project <slug>`

Every refresh/generate script that the workflows run takes `--project <slug>`
(or `--project=<slug>`). Without the flag it reads `HD_PROJECT`, then the
registry default (TEL), so existing commands behave exactly as before. The slug
must be in `config/projects.json`; the script loads `config/projects/<slug>.json`
and its data dir (`projectDataDir`).

The data workflows have a `project` input on manual dispatch and export it as
`HD_PROJECT` for every step (scheduled runs fall back to `tel`):

```sh
node scripts/pull-holders-rpc.js --project tel
gh workflow run refresh-tel-holders.yml -f project=tel
```

Today the scripts still read token addresses from `config/chains.json` and
write the `public/data/` root, so `pipelineProject()` only accepts
`legacyRoot` projects and exits with code 2 for any other slug rather than
writing one token's numbers under another project's name. Porting a script
means reading tokens from the project config and writing under its data dir.

## Adding the next project

1. Add `{ "slug": "<slug>", "name": "...", "ticker": "..." }` to `config/projects.json`.
   Slugs are lowercase `[a-z0-9-]`.
2. Add `config/projects/<slug>.json` using `tel.json` as the template. Use only
   verified addresses, never guessed ones.
3. Put the browser feeds in `public/data/<slug>/` (same file names as TEL, see
   `BROWSER_DATA_FILES` in `scripts/lib/browserDataFiles.js`).
4. Add the slug to `PROJECT_SLUGS` in `netlify/functions/live-data.mjs`.
   A test fails if it is missing.
5. Optional: add `copy` overrides for wording the generic templates get wrong.
6. Run `npm run typecheck && npx vitest run && npm run build`.

The switcher picks the new project up automatically.
