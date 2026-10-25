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
| Pipeline data paths and addresses | `projectPaths`, `projectChains`, `projectClassificationPath` in `scripts/lib/projects.js`; `scripts/lib/stakerTarget.js`; `scripts/lib/exchangeFlowChains.js` |

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

### Data-path rules

Every ported script resolves files through `projectPaths(project)` /
`projectDataPath(project, file)` in `scripts/lib/projects.js`:

| Project | Feeds, checkpoints, histories | Git-history reads (`readCommittedJson`) |
| --- | --- | --- |
| `data.legacyRoot: true` (TEL) | `public/data/<file>` (unchanged) | `public/data/<file>` |
| any other project | `public/data/<slug>/<file>` | `public/data/<slug>/<file>` |

File names are the same for every project (`tel-holders.json`,
`holders-lite.json`, `supply-reconciliation.json`, …; see
`BROWSER_DATA_FILES`). Absolute paths and `..` are refused. Ported scripts
`mkdir -p` the data dir before writing. TEL's files are **not** moved into
`public/data/tel/`.

### Address resolution

Ported scripts read every address from the project, never a literal:

| What | Helper | TEL | Other projects |
| --- | --- | --- | --- |
| Chain map (token address, decimals, `fromBlock`, `tokens.legacy/v3`, upgrade contracts, v3 staking modules) | `projectChains(project)` | `pipeline.chainsConfig` = `config/chains.json` (byte-identical to before) | `pipeline.chainsConfig` if set, else derived from `chains[]` by `deriveChainsFromProject()` |
| Exclusions / CEX / DEX / changelog | `projectClassificationPath(project, kind)`, `projectNonRetailPaths(project)` | `classification.*` (= the `config/` root files) | `classification.*`; **none declared = empty**, never TEL's lists |
| StakeChanged staking contract (pull-staker-balances, staker merge in pull-holders-rpc) | `resolveStakeChangedTarget(project)` (`scripts/lib/stakerTarget.js`) | `staking[]` entry `kind: "stakeChanged"` (Polygon `0x92e4…6330`, legacy TEL, block 36,751,757) | same; no entry = staker script exits 0 and nothing is merged |
| Receipt staking modules | `projectStakingContracts(project, { kind: "receiptModule" })` | `kind: "receiptModule"` | same |
| Exchange-flow scan table | `exchangeFlowChains(project, chains)` (`scripts/lib/exchangeFlowChains.js`) | old table: same start blocks, chunks, env overrides, divisor 100 | every chain in the map, start = `fromBlock` (or token `deployBlock`), divisor = `10 ** decimals`, override `FLOW_START_BLOCK_<CHAIN>` / `FLOW_CHUNK_<CHAIN>` |
| Supply target for reconciliation | `reconcileOptions(project)` (`scripts/reconcile-supply.js`) | 100B + CoinGecko comparison (unchanged) | `supply.target` (required); `supply.coingeckoCirculating` optional |

Chain-map token slots: the scanner's base token is the `legacy` slot. A
`generation: "legacy"` token fills it, or the only token of a
single-generation project. A `v3` generation enables TEL-style upgrade
netting through `tokenMigration` / `migrationVault` contracts. Per-chain wallet
columns are `<chainKey>_balance` for every chain in the map (TEL: ethereum,
polygon, base, in that order), and `reconcileSupply` treats every non-origin
chain as a mirror.

Optional per-project pipeline keys: `chains[].origin`, `chains[].fromBlock`,
`staking[].kind`, `staking[].deployBlock`, `pipeline.chainsConfig`,
`treasury.categories` (append-treasury-history lines; default TEL's four),
`supply.coingeckoCirculating`.

### Ported scripts vs the guard

A ported script calls `selectPipelineProject(name, { ported: true })` and may
run for any registered project. Ported:

- `pull-holders-rpc`
- `generate-holders-lite`
- `generate-holders-history`
- `reconcile-supply`
- `pull-staker-balances`
- `append-treasury-history`: a non-legacy project with no history yet starts a new series; TEL still refuses an empty history.
- `scan-exchange-flows`

Every other script still calls `selectPipelineProject(name)` without
`ported`. It reads `config/chains.json` / the `public/data/` root directly, so
it accepts only `legacyRoot` projects and **exits 2** for any other slug.
A workflow dispatched with a non-TEL `project` therefore fails at the first
un-ported step instead of writing the wrong token's numbers. To port a script,
switch its paths to `projectPaths()` and its addresses to the helpers above,
pass `{ ported: true }`, and add a TEL-unchanged test to
`scripts/lib/projectPipeline.test.js`.

Known limits for a second token (not yet needed by TEL):
`scripts/lib/rpc.js` only has key/public RPC pools for ethereum, polygon and
base. Holder metrics thresholds (`RETAIL_THRESHOLD`, `MEGA_HOLDER_THRESHOLD`)
are TEL-sized constants. The workflows still commit `public/data/*.json` paths
only.

## Adding the next project

1. Add `{ "slug": "<slug>", "name": "...", "ticker": "..." }` to `config/projects.json`.
   Slugs are lowercase `[a-z0-9-]`.
2. Add `config/projects/<slug>.json` using `tel.json` as the template. Use only
   verified addresses, never guessed ones.
3. Put the browser feeds in `public/data/<slug>/` (same file names as TEL, see
   `BROWSER_DATA_FILES` in `scripts/lib/browserDataFiles.js`). Ported pipeline
   scripts write there when run with `--project <slug>`. Give the config
   `supply.target`, `staking[].kind` / `deployBlock` and its own
   `classification.*` files.
4. Add the slug to `PROJECT_SLUGS` in `netlify/functions/live-data.mjs`.
   A test fails if it is missing.
5. Optional: add `copy` overrides for wording the generic templates get wrong.
6. Run `npm run typecheck && npx vitest run && npm run build`.

The switcher picks the new project up automatically.
