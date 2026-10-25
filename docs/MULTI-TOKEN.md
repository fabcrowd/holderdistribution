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
| Pipeline data paths and addresses | `projectPaths`, `projectWork`, `projectChains`, `projectClassificationPath` in `scripts/lib/projects.js`; `scripts/lib/stakerTarget.js`; `scripts/lib/exchangeFlowChains.js` |
| Workflow commit paths | `scripts/workflow-paths.js` |

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
Still TEL-specific on purpose: the v3 StakingModule constants in
`src/lib/staking.ts` (only TEL has that module). The gated forensics views are
multi-token (see "Gated forensics" below).

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

| Project | Feeds, checkpoints, histories | Git-history reads (`readCommittedJson`) | Working files (`projectWork`) |
| --- | --- | --- | --- |
| `data.legacyRoot: true` (TEL) | `public/data/<file>` (unchanged) | `public/data/<file>` | `data/<file>` (unchanged) |
| any other project | `public/data/<slug>/<file>` | `public/data/<slug>/<file>` | `data/<slug>/<file>` |

Working files are the non-served state under `data/`: `holders-asof-blocks.json`,
`tier-outflows-days.json` / `-checkpoint.json`, `cex-candidates.json`, the
`rebuild-transfers-<chain>` and `asof-window-*` transfer caches (gitignored for
every project). `projectWork(project)` /
`projectWorkPath(project, file)` resolve them (subpaths allowed, absolute
paths and `..` refused). Before this, `pull-holders-rpc` and
`generate-holders-lite` read TEL's `data/holders-asof-blocks.json` and transfer
caches for every project; they now use the project's own.

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
- `append-exchange-flows-from-cache`: CEX/DEX lists from `classification.*` (a project with no CEX list throws); sanity cap = 2 × `supply.target`.
- `check-feed-consistency`: changelog falls back to `{ events: [] }`; treasury categories from `treasury.categories` (default TEL's four).
- `detect-cex-candidates`: writes `data/<slug>/cex-candidates.json`; chains it has no tuning for use chunk 2,000 / lookback 300,000 blocks.
- `extend-transfer-caches`: every chain in the project's chain map; caches under `data/<slug>/`.
- `fill-history-gaps`: runs its child scripts with `--project <slug>`.
- `generate-holder-transitions`: tier ranges are still TEL-sized (see limits below).
- `generate-tier-outflows`: TEL keeps exactly ethereum/polygon/base with its chunk and blocks-per-day table and divisor 100; other projects scan every mapped chain with `chains[].blocksPerDay` (default 43,200), divisor `10 ** decimals`, `FLOW_CHUNK_<CHAIN>`. Staking contract from `resolveStakeChangedTarget` (none = no staking split).
- `pull-cex-wallets`: no `classification.cexWallets` = an empty `cex-wallets.json`.
- `rebuild-history-from-logs`: the StakeChanged chain/contract come from `resolveStakeChangedTarget` instead of a hardcoded Polygon check.
- `recompute-history-from-git`
- `resync-chain-holders`
- `sync-cex-wallets-dune`: needs `classification.cexWallets` and a query id (`DUNE_QUERY_ID` env, then `pipeline.duneCexQueryId`; TEL keeps its built-in query). Missing either = exit 2.
- `sync-classification-changelog`: no `classification.changelog` = an empty events feed.
- `validate-outputs`
- `generate-wallet-flows` (gated; see "Gated forensics" below): inputs and
  output from `walletFlowsPlan()` (`scripts/lib/walletFlowsProject.js`). A
  project with no forensics registry exits 0 before any RPC call.

Every workflow script is ported now. The guard stays: a future script that
calls `selectPipelineProject(name)` without `ported` reads `config/chains.json` /
the `public/data/` root directly, so it accepts only `legacyRoot` projects and
**exits 2** for any other slug. A workflow dispatched with a non-TEL `project`
then fails at that step instead of writing the wrong token's numbers. To port a script,
switch its paths to `projectPaths()` and its addresses to the helpers above,
pass `{ ported: true }`, and add a TEL-unchanged test to
`scripts/lib/projectPipeline.test.js` / `projectPipelinePorts.test.js` (the
latter also fails if a ported script keeps a `public/data/`, `data/` or
`config/<classification>.json` literal outside comments).

### Workflow commit paths

Each data workflow runs `node scripts/workflow-paths.js >> "$GITHUB_ENV"`
after `npm ci`, which exports `HD_DATA_DIR` / `HD_WORK_DIR` (TEL:
`public/data` / `data`; others: `public/data/<slug>` / `data/<slug>`) and
`HD_CEX_CONFIG`. Commit steps keep their TEL file lists and pass them through
`node scripts/workflow-paths.js files <paths…>`:

- TEL: the list is printed unchanged, so TEL runs stage exactly the same paths.
- Other projects: `public/data/<f>` → `public/data/<slug>/<f>`, `data/<f>` →
  `data/<slug>/<f>`, `config/cex-wallets.json` (and the other classification
  root files) → the project's `classification.*` file. Missing files are
  dropped and `public/data/<slug>` itself is added, so the commit covers
  `public/data/<slug>/**`. A path with no per-project mapping is refused.

Known limit for a second token: the `refresh-tel-holders` verify step requires
the same feed set for every project (including `funding-wallets.json` and
`treasury-history.json`).

## Holder tiers and thresholds (`holders`)

Every holder-size number used to be sized for TEL. It now lives in the project
config's `holders` block. Any field you leave out falls back to
`config/holder-tiers.default.json` (the TEL values). `tel.json` carries an
explicit copy, and `scripts/lib/holderTiers.test.js` pins it to the old literals.

```json
"holders": {
  "retailThreshold": 1000,
  "megaHolderThreshold": 20000000000,
  "concentrationBuckets": [10, 25, 50, 100, 250, 500, 1000],
  "balanceRanges":     [{ "label": "1–100", "min": 1, "max": 100 }, …, { "label": "10M+", "min": 10000000, "max": null }],
  "distributionTiers": [{ "label": "500M+", "min": 500000000, "max": null }, …, { "label": "1-250K", "min": 1, "max": 250000 }]
}
```

- Units are whole tokens. `min` is inclusive, `max` is exclusive, and
  `max: null` means open-ended.
- `balanceRanges` go smallest to largest and `distributionTiers` go largest to
  smallest. Labels must be unique. The loader (`scripts/lib/holderTiers.js` and
  `src/lib/holderTiers.ts`) throws on a bad order or a bad bound.
- Who reads it:
  - Pipeline: `pull-holders-rpc` and `resync-chain-holders` use the retail and
    mega thresholds. `recompute-history-from-git` and `rebuild-history-from-logs`
    use all of it through `setHolderTiers`. `generate-holders-lite`,
    `generate-holder-transitions` and `generate-tier-outflows` use the tier
    ranges.
  - UI: `useProjectCopy().tiers` feeds the tier-flow diagram (rows and canvas
    height through `useTierGeometry`), the Wallet Holdings curve and the
    Distribution "Sub-N dust" pill.
- Distribution tier labels are join keys between `holders.json`,
  `holders-history.json`, `holder-transitions.json` and `tier-outflows.json`.
  If you change a project's tiers, regenerate its history as well. Old
  snapshots keep their old labels.
- `pull-holders-rpc` now checks the supply sanity tolerance against
  `supply.target` instead of the 100B TEL constant.

## RPC pools for project chains (`chains[].rpc`)

`scripts/lib/rpc.js` builds a key pool for every chain from `<PREFIX>_RPC_0..9`
(from `.env.enc`). The built-in prefixes are `ETH`, `MATIC` and `BASE`. Any other
chain defaults to its upper-cased key (`arbitrum` → `ARBITRUM_RPC_n`). After the
key pool come free public endpoints, which are probed on every run. A chain can
override both in its project config:

```json
{ "key": "arbitrum", "name": "Arbitrum One", "chainId": 42161, "explorer": "https://arbiscan.io",
  "rpc": { "envPrefix": "ARB", "publicUrls": ["https://arbitrum-one-rpc.publicnode.com"] } }
```

- `selectPipelineProject` calls `configureProjectRpc(project.config)`, so every
  ported script picks this up without extra code.
- Public URL precedence: the `PUBLIC_RPC_URLS_<CHAIN>` env var, then
  `chains[].rpc.publicUrls`, then the built-ins.
- Built-in free starters exist for ethereum, polygon, base, arbitrum, optimism,
  bsc and avalanche. The four newer ones are unverified, and TEL does not use
  them.
- Use free public RPCs only (no paid providers). Only add `<PREFIX>_RPC_n` keys
  to `.env.enc` if a chain needs them.
- TEL declares no `rpc` blocks, so its pools are unchanged
  (`scripts/lib/rpcProjectChains.test.js`).
- The UI's Chain Status card takes its labels, explorers and token links from
  `chains[]` (`projectChainMeta`).

## Chain views (`chains[]` drives every chain picker)

The Holders / Distribution / Supply widgets no longer use a fixed
`"combined" | "ethereum" | "polygon" | "base"` union. `src/lib/chainViews.ts`
derives the views from the active project's `chains[]`, in config order:

- `ChainView` is `"combined"` or any project chain key (`DisplaySelection`,
  `HeadlineView` and the hook `view` params are aliases of it; the tier-flow
  diagram uses `"all"` or a chain key).
- `chainViewOptions(project, combinedLabel)` feeds the terminal chain select
  ("All chains"), the Wallet Holdings tabs ("Combined"), and the
  HolderGrowth / Distribution labels.
- `?chain=` in the URL (`historyNav.readSettings`) is validated against the
  active project's chains. Switching to a project without the selected chain
  falls back to Combined (`coerceChainView`).
- The Staked tile's "Staking runs on …" note comes from `staking[].chain`
  (`stakingElsewhereNote`). TEL still reads "Staking runs on Polygon".
- `chain-status.json` covers the project's chain keys
  (`buildChainStatus(checkpoint, chainKeys)`). It defaults to TEL's three chains.
- Wallet-flow address links use the project's `chains[].explorer` for chains
  without a built-in explorer.

TEL resolves to exactly the old Combined / Ethereum / Polygon / Base views,
labels and order (`src/lib/chainViews.test.ts`). The same test covers a demo
project with an extra `arbitrum` chain and fails if a hard-coded union comes
back. Feeds are already keyed by chain (`holders-lite.json` `views.<key>`,
history `chains.<key>`), so a fourth chain needs no UI code changes.

## Chain discovery (`detect-token-chains`)

Use this during the onboarding questionnaire to find out whether a token is
also deployed on EVM chains that its config does not list. It is advisory
only: it never edits config.

```
node scripts/detect-token-chains.js --project <slug> [--coingecko] [--out report.json]
node scripts/detect-token-chains.js --address 0x… --chain ethereum --ticker ABC [--coingecko]
```

- **Same-address probe:** runs free public RPCs only (`scripts/lib/rpc.js`
  fallbacks or `chains[].rpc.publicUrls`). On each candidate chain that is not
  already configured (ethereum, polygon, base, arbitrum, optimism, bsc and
  avalanche), it runs `eth_getCode`, then `symbol()` and `decimals()` for every
  known token address. This finds CREATE2 or multichain deployments at the
  same address.
- **`--coingecko` (optional):** calls CoinGecko's keyless public
  `/coins/<platform>/contract/<address>` endpoint and reads its `platforms`
  map. This finds bridged copies at different addresses. Each listed address is
  then confirmed on-chain with the same probe. If CoinGecko rate-limits or does
  not list the token, the report still uses the RPC results.
- **Statuses:** each chain is marked `configured`, `candidate` (code plus a
  matching symbol), `contract-other-symbol` (code exists but is a different
  token, so do not add it), `not-found` or `rpc-error`.
- **Before adding a candidate to `chains[]`:** confirm it from the project's
  bridge docs or the explorer's token tracker. A matching symbol alone does not
  prove anything.

TEL result (2026-10-25): no candidates beyond ethereum, polygon and base.
When run with only a Polygon seed, the probe finds TEL v3 on Ethereum and Base
at the same address.

Deferred: non-EVM chains, bridge-registry lookups (e.g. the Superchain token
list, Axelar or Wormhole registries), and a scheduled discovery run. All of
these can feed into `detectTokenChains` as further address sources.

## TEL-sized values left on purpose

| Where | What | Why it stays |
|---|---|---|
| `scripts/lib/holderHistoryReconcile.js` | Default lowest label `"1-250K"` | This is only the default. `buildViewData` passes the project's lowest distribution tier. |
| `scripts/lib/holderMetrics.js` | Exported `RETAIL_THRESHOLD` / `MEGA_HOLDER_THRESHOLD` | These are the TEL defaults, kept for existing imports. The scripts read the project values. |
| `src/components/tierflow/geometry.ts` | `TIERS`, `CANVAS_H` | These are TEL defaults and test anchors. The live diagram uses `useTierGeometry()`. |
| `scripts/lib/supply.js`, `reconcileSupply` | `EXPECTED_MAX_SUPPLY` / `TEL_TOTAL_SUPPLY` (100B) | These are defaults only. Callers pass `supply.target`. |
| `scripts/verify-tel-supply.js` | 100B | This script only checks TEL. |
| `scripts/generate-tier-outflows.js` | `CHAIN_TUNING` (log-window sizes per chain) | Unknown chains fall back to the chain's `blocksPerDay`. |
| `MIN_TEL_RAW = 1` | Dust floor of 1 raw unit | This is a chain-level floor, not a value sized for TEL. |
| `scripts/lib/stakingDiscovery.js` | `STAKE_SCAN_SPAN` | This is a block span, not a supply amount. |
| CEX balance / Dune query | Per-project query | A new project needs its own Dune query id. The current Dune key keeps being used. |

## Gated forensics (wallet flows, ledger, write-ups)

Wallet-level analysis is multi-token and stays **gated**. Today the gate is the
forensics password or an admin session; the plan is a **paywall** that replaces
the password check. Nothing wallet-level is ever served from `public/`,
`/data/` or `/live-data/`. Every project uses the same panels and the same gate
keys.

| Piece | TEL (`legacyRoot`) | Any other project |
| --- | --- | --- |
| Wallet-flows registry (labels, bot cluster, watched sellers; hand-edited) | `data/forensics/wallet-flows.registry.json` | `data/<slug>/forensics/wallet-flows.registry.json` |
| Wallet-flows report (generated) | `data/forensics/wallet-flows.json` | `data/<slug>/forensics/wallet-flows.json` |
| Reconciliation it starts from | `public/data/supply-reconciliation.json` | `public/data/<slug>/supply-reconciliation.json` |
| CEX / DEX lists | `classification.*` (= `config/` root files) | `classification.*`, none declared = empty |
| Price (USD columns) | `gated.walletFlows.coingeckoId` = `telcoin` | `gated.walletFlows.coingeckoId`; none = carried over / 0 |
| Bridge infrastructure | TEL's `BRIDGE_INFRA` (`scripts/lib/telEndpoint.js`) | `gated.walletFlows.bridgeAddresses` only |
| Disposition ledger, foundation stablecoin flows, wallet write-ups | bundled TEL files (unchanged) | none yet, so the gate returns `null` |

Optional `gated.walletFlows` keys: `coingeckoId`, `chains` (default: every
chain in the project's chain map), `bridgeAddresses`, `dexVenues` (on top of
`classification.dexContracts`; the chain-wide aggregators CoW/1inch/Kyber/0x
always apply), `logSpan.<chainKey>`.

**Pipeline:** `node scripts/generate-wallet-flows.js --project <slug>`, or
dispatch `refresh-wallet-flows.yml` with `project=<slug>` (the weekly schedule
stays TEL). The commit step maps `data/forensics/wallet-flows.json` through
`workflow-paths.js files`, so a TEL run stages exactly what it did before. To
start a project's forensics, commit its registry under `data/<slug>/forensics/`.

**Gate** (`netlify/functions/forensics-gate.cjs`, source in `netlify/functions-src/`):
the POST body takes an optional `project` (a registry slug; missing = the
default project, TEL, so old clients behave the same). The access check
(password / session token / admin) comes **before** the project is read, and
is the same for every project. Then:

- `wallet-flows`: TEL serves the bundled report, or a newer committed copy when
  `LIVE_DATA_GITHUB_TOKEN` is set. Other projects only get the committed copy
  under `data/<slug>/forensics/`, fetched with that token; with no report,
  `report: null` and `X-Wallet-Flows-Source: none`. Cached per project for 1 h.
- `disposition-ledger` (old key `tel-disposition-ledger` still works),
  `association-stablecoin-flows`, wallet write-ups: from `STATIC_GATED[slug]`.
  Only TEL has entries, so other projects get `null`, never TEL's data.
- An unregistered `project` returns `400`. `gatedProjects.ts` reads the
  registry bundled into the function, so a new slug is accepted
  automatically. Only `LEGACY_ROOT_SLUGS` has to match `data.legacyRoot`, and a
  test checks that.

**UI:** `WalletFlowsPanel`, `TelDispositionLedger`, `AssociationFlowAnalysis` and
`useWalletAnalysis` key their queries by `useProject().slug` and pass it to
the loaders in `src/lib/loadForensics.ts`. A `null` payload renders an empty
"nothing mapped for <project> yet" state. Panel copy is templated
(`{name}`/`{ticker}`; TEL's locked-panel supply line is the
`walletFlows.locked.supply` override), so TEL reads exactly as before. The
one unlock still covers every project.

**Paywall (not built yet).** The intended replacement:
1. Replace `passwordMatches` / `issueToken` in `gateAuth.ts` with a
   subscription check (for example Stripe customer → entitlement) that issues
   the same `hdg1.` session token, with the entitled project slugs (or "all")
   in its payload.
2. In `forensics-gate.ts`, after `resolveGatedProject`, refuse a project the
   token is not entitled to (`402`/`403`). The data paths and keys above stay
   the same.
3. Replace `ForensicsUnlockGate`'s password form with sign-in / checkout. The
   `useForensicsUnlock` session handling and every panel stay as they are.
4. Keep the admin bypass. Retire `FORENSICS_PASSWORD*` once subscribers have
   been moved over.

Not yet generalized: the ledger and wallet write-up generators
(`supabase/functions/wallet-analysis-gate/tel-disposition.generated.ts`,
`src/data/forensicsWriteups.ts`) are TEL's hand-built sources; another
project's equivalents get an entry in `STATIC_GATED` (or a committed
`data/<slug>/forensics/` file). The ledger's inner tables still use TEL
wording, and only render when a project has a ledger.

## Adding the next project

1. Add `{ "slug": "<slug>", "name": "...", "ticker": "..." }` to `config/projects.json`.
   Slugs are lowercase `[a-z0-9-]`.
2. Add `config/projects/<slug>.json` using `tel.json` as the template. Use only
   verified addresses, never guessed ones. Run
   `node scripts/detect-token-chains.js --address 0x… --chain <origin> --ticker <T> --coingecko`
   first so `chains[]` includes every chain the token is on (see "Chain
   discovery"). Each extra chain gets a picker view automatically.
3. Put the browser feeds in `public/data/<slug>/` (same file names as TEL, see
   `BROWSER_DATA_FILES` in `scripts/lib/browserDataFiles.js`). Ported pipeline
   scripts write there when run with `--project <slug>`. Give the config
   `supply.target`, `staking[].kind` / `deployBlock` and its own
   `classification.*` files.
4. Add the slug to `PROJECT_SLUGS` in `netlify/functions/live-data.mjs`.
   A test fails if it is missing.
5. Optional: add a `holders` block if TEL's tier sizes don't fit the supply, and
   `chains[].rpc` for chains other than ethereum, polygon and base.
6. Optional: add `copy` overrides for wording the generic templates get wrong.
7. Run `npm run typecheck && npx vitest run && npm run build`.

The switcher picks the new project up automatically.
