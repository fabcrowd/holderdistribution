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
| Routes (`/` landing, `/<slug>` terminal, legacy redirects) | `src/App.tsx`, `src/lib/tokenRoutes.ts`, `src/components/routing/` |
| Landing cards | `src/pages/Landing.tsx`, `src/components/TokenCard.tsx`, `src/lib/landingStats.ts` |
| Token image + header mark | `public/tokens/<slug>.<png or jpg>` (config `image`), `src/components/TokenIdentity.tsx` |
| Project-driven copy | `src/lib/projectCopy.ts`, `useProjectCopy()` (`src/hooks/useProjectCopy.ts`), `src/lib/glossary.ts` |
| Pipeline `--project` | `parseProjectArg` / `pipelineProject` in `scripts/lib/projects.js` |
| Pipeline data paths and addresses | `projectPaths`, `projectWork`, `projectChains`, `projectClassificationPath` in `scripts/lib/projects.js`; `scripts/lib/stakerTarget.js`; `scripts/lib/exchangeFlowChains.js` |
| Workflow commit paths | `scripts/workflow-paths.js` |

The active project is the URL path: `/<slug>` (e.g. `/tel`, `/zebec-network`).
`/` is the landing page (one card per project) and never auto-redirects.
Legacy `/?token=<slug>`, `/holders` and `/holders?token=<slug>` redirect to
`/<slug>` (`legacyRedirect` in `src/lib/tokenRoutes.ts`); an unknown slug is a
404. There is no token switcher: the header's token image + name link home.
Every feed hook keys its query by slug. A slug must not be one of
`RESERVED_ROOT_SEGMENTS` (a test enforces it).

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
- Entity slots (Supply view): the pie uses one bucket set for every project
  — Retail, DEX, CEX, Treasury, Team, Holdings, Escrow, Other, Supply gap —
  and hides empty slices. Staked tokens stay inside Retail; staking reward
  vaults / reward contracts are developer-controlled, so give them category
  `staking` (a contracts{} role `staking`, or an exclusions label) and they
  count in Team (`TEAM_CATEGORY_KEYS` in `src/lib/supplyBreakdown.ts`).
  Treasury's label is `copy.text` `entity.association`
  (generic: "Treasury"; TEL keeps "Telcoin Association-Controlled Safes";
  ZBCN is "Zebec Treasury & Buyback Vaults"). Holdings is `entity.holdings`
  (generic: "Holdings"). Also `entity.associationShort` /
  `entity.holdingsShort`, plus `supply.association.description`, `supply.holdings.description`,
  `supply.escrow.description`, `treasury.series.council`,
  `treasury.history.info`.
- The site footer disclaimer is shared legal copy in `src/components/Footer.tsx`
  (independent platform; not endorsed, paid, or affiliated with any token or
  project; not advice; not an offer or solicitation; no warranty). It is not
  a per-project slot.
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
`HD_PROJECT` for every step. `refresh-tel-holders.yml` (the daily refresh) takes a
slug or `all` (the default, and what the schedule runs):

```sh
node scripts/pull-holders-rpc.js --project tel
gh workflow run refresh-tel-holders.yml -f project=tel
```

### Onboarding a token: config only

The daily refresh is registry-driven: a `plan` job runs
`node scripts/workflow-paths.js matrix`, which lists every project in
`config/projects.json` (default first), and the `refresh` job runs once per
project (`max-parallel: 1`, `fail-fast: false`, `timeout-minutes` from
`pipeline.workflowTimeoutMinutes` in the project file, default 60). To add a
token: register it in `config/projects.json`, add `config/projects/<slug>.json`
(optionally `pipeline.workflowTimeoutMinutes`), and nothing else. Stage
differences come from that config (`workflowPlan` in `scripts/workflow-paths.js`):
the verify list, the `[skip netlify]` tag (only the registry default publishes),
and whether the EVM gap fill runs (any EVM chain); the staker and Solana
staking pulls exit 0 when the project has no such staking contract. A project
whose config is broken is skipped with a warning, so a half-onboarded token
cannot stop the others. Pushes go through `scripts/push-main.sh` (rebase +
push, up to 5 attempts).

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
| Supply target for reconciliation | `reconcileOptions(project)` + `resolveCoingeckoCirculating` (`scripts/reconcile-supply.js`) | 100B. CoinGecko circulating is fetched for `supply.coingeckoId` (`telcoin`); a missing live read keeps TEL's traced snapshot | `supply.target` (required). CoinGecko circulating is fetched for `supply.coingeckoId` (else `gated.walletFlows.coingeckoId`). No id, or no positive read, publishes `null` and the UI hides the row |

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
`treasury.labelEras` (`[{before, categories:{address: oldCategory}}]`: backfill-treasury-cex-history replays rows dated before `before` with the older labels),
`supply.coingeckoId` (CoinGecko coin id whose circulating supply reconcile-supply fetches; unset hides the comparison).

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
- `sync-cex-wallets-dune`: needs `classification.cexWallets` and a query id (`DUNE_QUERY_ID` env, then `pipeline.duneCexQueryId`; TEL keeps its built-in query). Missing either = exit 2. Address handling follows the project's VM (`scripts/lib/duneCex.js`): EVM rows stay 0x-hex lowercased (TEL unchanged); a Solana-only project keeps base58 exactly as written and skips rows whose `blockchain` is not `solana`. `--candidates` (forced when the project has no `classification.cexWallets`) never writes a production list: it intersects the labels with the holder snapshot and writes `data/<slug>/cex-dune-candidates.json` for owner review. `--source spellbook` (candidates-only, Solana-only, no key) reads the public Dune spellbook model behind `cex_solana.addresses` instead of the API.
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

The `refresh-tel-holders` verify list is per project (`HD_REQUIRED_FILES`,
derived from the project's staking config), so a mapped project needs no
workflow of its own (see [zebec-network](#zebec-network-solana) below).

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

- **Solana:** a Solana row appears only when the project already has a Solana
  chain or CoinGecko's `platforms.solana` lists a mint. The mint is kept in its
  base58 case and confirmed with free Solana RPC (mint owner program, decimals,
  Token-2022 or Metaplex symbol). Statuses: `configured`, `candidate`,
  `listed-unverified` (CoinGecko lists it but RPC could not confirm it),
  `contract-other-symbol`, `rpc-error`. A base58 `--address` implies
  `--chain solana`:
  `node scripts/detect-token-chains.js --address <mint> --chain solana --ticker ABC --coingecko`.
- **Bridge suggestion:** every candidate row carries `suggestedBridge: "native"`
  and `bridgeNeedsConfirmation: true`. The `bridge` value you write into config
  (`native` | `lock-mint` | `burn-mint`, see "Wrapped / bridged tokens") must
  come from the project's bridge docs. Discovery never writes `chains[]`.

Deferred: bridge-registry lookups (e.g. the Superchain token list, Axelar or
Wormhole registries), non-EVM chains other than Solana, and a scheduled
discovery run. All of these can feed into `detectTokenChains` as further
address sources.

## Solana chains (`chains[].vm: "solana"`)

Chain support is pluggable by VM (`scripts/lib/chainAdapters.js`):
`chains[].vm` is `"evm"` (the default) or `"solana"`; a chain keyed `solana`
with no `vm` is treated as Solana. The Solana adapter
(`scripts/lib/solana/adapter.js`) is imported lazily, and only when a project
lists a Solana chain. An EVM-only project like TEL never loads it
(`chainAdapters.test.js`).

```json
{ "key": "solana", "name": "Solana", "vm": "solana", "cluster": "mainnet-beta",
  "bridge": "native",
  "tokens": [{ "address": "<mint, base58>", "program": "spl-token", "decimals": 6, "status": "canonical" }],
  "contracts": { "bridgeCustody": { "address": "<owner wallet/PDA, base58>", "role": "bridge" } } }
```

- **Validation** (`validateProjectConfig`, run by `resolveProject`; it fails
  before any network call): mints and addresses must be base58 that decodes to
  32 bytes. `chainId`, `fromBlock` and token `deployBlock` are rejected on
  Solana chains. `program` must be `spl-token` or `token-2022`, `decimals` must
  be 0–18, and `cluster` must be `mainnet-beta`. `cluster` and `program` are
  rejected on EVM chains. `explorerTemplates` values must be https and contain
  `{address}` / `{tx}`.
- **Addresses:** hex is lowercased, base58 is **never** lowercased
  (`scripts/lib/address.js`, `normalizeAnyAddress`). Every set and lookup
  (non-retail sets, history, transitions, reconciliation, lock sets) goes
  through it.
- **RPC:** same pattern as EVM. Free public RPC first
  (`https://api.mainnet-beta.solana.com`, or `PUBLIC_RPC_URLS_SOLANA` /
  `chains[].rpc.publicUrls`), then optional `SOLANA_RPC_0..9` keys from
  `.env.enc`. Every URL is probed with `getHealth`, and `PUBLIC_RPC_FALLBACK=0`
  disables the public endpoints.
- **Holder scan:** `getProgramAccounts` on the token's program (SPL: `dataSize
  165` plus mint `memcmp`; Token-2022: mint `memcmp` only) with `jsonParsed`.
  Balances are summed per **owner**, so ATAs collapse into one wallet, and zero
  balances are dropped. If the scanned sum is more than 1% off the mint supply,
  the scan refuses to publish, so a partial set is never shown as complete.
  Public RPCs often refuse `getProgramAccounts` for large mints. If every URL
  fails, the error says to set `SOLANA_RPC_0` (a free-tier key).
- **Metadata:** Token-2022 metadata extension, then the Metaplex metadata PDA,
  then `tokens[].symbol` / `ticker`. Decimals and program always come from the
  mint. A config value that disagrees with the mint fails the run.
- **Feeds:** same shapes as EVM (`views.solana`, history `chains.solana`).
  Combined merges every configured chain. Overlap/dedup only works within one
  address format, so a Solana owner never matches an EVM address.
  `chain-status.json` writes `{ lastBlock: <slot>, vm: "solana", scannedAt }`
  for Solana, and the Chain Status card marks the chain "(stale)" when its scan
  is more than 1 h older than the feed. EVM entries stay `{ lastBlock }`.
- **Explorers:** Solscan by default (`/token/`, `/account/`, `/tx/`).
  `explorer` or `explorerTemplates` override it (`src/lib/explorerLinks.ts`,
  mirrored in `chainAdapters.js`).
- **Scope:** `projectChains()` returns EVM chains only by default, so the
  EVM-only scripts (flows, tier outflows, staking discovery, forensics log
  scans) skip Solana. Only `pull-holders-rpc` asks for every VM
  (`projectChainsAllVms`). `--as-of` is refused for projects with a Solana
  chain.
- **Smoke test (read-only):** `node scripts/solana-smoke.js --mint <base58> [--scan]`.
  Verified 2026-10-25 on public RPC: USDC (SPL, Metaplex metadata) and PYUSD
  (Token-2022 extension).

Solana staking is built for one program kind, `zebecStakeV1` (see
[zebec-network](#zebec-network-solana)). Not built (deferred): other Solana
staking programs, wallet-to-wallet (non-venue) flows, forensics, history back-fill before
the first snapshot, historical `--as-of` snapshots, and other non-EVM chains.

## zebec-network (Solana)

The first non-TEL project, mapped 2026-10-25
(`docs/superpowers/plans/2026-10-25-zbcn-mapping.md`).

- **Identity:** slug `zebec-network` (`config/projects/zebec-network.json`,
  `/zebec-network`, registered in `config/projects.json`).
  Mint `ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU` (SPL, 6 decimals),
  **Solana-only** (`origin: true`, `bridge: "native"`). The chain tabs are
  Combined and Solana, and the explorer is Solscan. Feeds are in
  `public/data/zebec-network/` and the work dir is `data/zebec-network/`.
- **Daily refresh:** the `zebec-network` leg of the registry-driven matrix in
  `.github/workflows/refresh-tel-holders.yml` (00:00 UTC, right after TEL; the
  separate `refresh-zebec-network.yml` and its 01:30 cron were retired). It
  commits with `[skip netlify]` (only the registry default publishes,
  `deployTriggers.test.js`); the data goes live through the live-data function.
  Stages are the shared ones: Solana staking pull (the EVM staker pull exits 0
  here), holders, `pull-cex-wallets` (51 CEX wallets: stages `cex-wallets.json`,
  `cex-flows.json`, `cex-balance-history.json`), lite, history, transitions,
  supply, treasury, changelog, verify (includes `solana-staking.json`), gate,
  commit, then `scan-exchange-flows` and `generate-tier-outflows` (empty feeds,
  no EVM chain) and a second commit; the EVM gap fill is skipped.
  `workflowChain.test.js` pins the matrix wiring.
  `public/data/*/tel-holders-previous.json` (a same-run scratch file) is
  gitignored, so it is never staged.
- **RPC:** `SOLANA_RPC_0` is an **Actions secret** (a Helius HTTPS URL). Locally
  it lives in the gitignored `.env`. `loadEnv` only overwrites keys that exist
  in `.env.enc`, and `.env.enc` has no `SOLANA_RPC_*`, so the secret survives.
  Public mainnet RPC refuses `getProgramAccounts` for this mint, which is why
  a key is required.
- **Staking (`zebecStakeV1`):** `scripts/pull-solana-staking.js` →
  `solana-staking.json` (`scripts/lib/solana/zebecStake.js`). Positions are
  every unclaimed `UserStakeData`, summed per staker. The lockup stake-vault
  ATAs and the reward vaults are `contracts{}` with role `staking`, so the
  accounts themselves are non-retail. **Staked is inside Retail**, the TEL
  way: `pull-holders-rpc.js` reads this feed and credits each position to the
  staker, then reduces stake-vault custody by the same amount
  (`attributeCustodyStaking`). The Staked tile stays a subset
  (`stakingV3Balance` / the v3 overlay) and is not added on top. Positions
  above vault custody are scaled down in that credit so supply is not
  invented; the tile still shows the raw sum. Reward vaults are not custody
  for those positions and fold into Other on the supply pie (not their own
  slice). The staking pull is non-fatal in the workflow, so holders still publish; if the feed is
  missing, vault balances stay uncredited and a warning is logged.
- **Vault-gap rule (standing):** each lockup's position sum is reconciled
  against its vault ATA (0.5% tolerance), and a mismatch refuses to publish.
  When a gap is a real on-chain property, add an exemption
  (`STAKE_VAULT_GAP_EXEMPTIONS`, keyed by exact lockup address) and an
  explainer. The feed records `vaultGapRaw`, `vaultGapRatio`,
  `vaultReconcile: "exempt"` and the explainer text. The Staked tile shows
  positions as they are on-chain: it does not scale them to the vault, and
  the publisher does not loosen every lockup to an overall-only check.
  The holder snapshot's credit is separate and does scale down to custody
  when the raw sum runs ahead, so that gap is not invented into Retail.
  Today one lockup is exempt: ZBCN Lockup
  `AYbW5cbZ…SJjp`, with a gap of about 2.42% between unclaimed positions and
  the vault ATA.
- **Holder tiers:** a per-project `holders.megaHolderThreshold` of 25B keeps
  the ~20.55B top wallet in the lite `totalBalance`. TEL keeps its 20B.
- **History is forward-only:** it starts at the first snapshot (2026-10-25).
  `--as-of` is refused for Solana projects, so there is no back-fill.
  `generate-holders-history.js` writes `solana-staking.json`'s measured
  `stakedTotal` onto `combined.stakingV3Balance` when there is no legacy
  staking contract. It does not also copy that number onto `stakingBalance`
  (the chart adds the two fields). The Staked chart plots that program-only
  total as one series.
- **CEX wallets:** 44 Solana addresses in
  `config/projects/zebec-network/cex-wallets.json` (11 owner-approved Dune
  spellbook rows plus 33 Solscan name-tag wallets, PR #43). The daily job
  refreshes them with `pull-cex-wallets`. `pipeline.duneCexQueryId` is **not
  set** — do not invent one, and do not reuse TEL's 3761086. Until the owner
  supplies a Solana `cex.addresses` query id, the list stays the hand-applied
  file.
- **Exchange and tier flows come from `scan-solana-flows.js`:** see
  [Solana venue flows](#solana-venue-flows) below. Until that script has run,
  `exchange-flow-history.json` and `tier-outflows.json` stay empty
  (`complete: false`) so the terminal shows an empty state instead of a 404.
- **Treasury and team are live (PR #44):** `buybackTreasury`
  (`EkXEg6de…QuQW`, off-curve PDA, role `treasury`) plus owner-approved vaults
  `H8Hr…DDfR`, `3J7n5…dQ17` and `71LxiE…HodV` (role `treasury`) and the team
  signer cluster (role `holdings`). GXD2, 43wqg and 56veX are still
  candidates. Evidence: `docs/zbcn-wallet-candidates.md`. The classification
  changelog records the #43 CEX list and the #44 treasury/team relabel
  (`classification.changelog`).
- **Supply:** `reconcile-supply.js` classifies from `contracts{}` roles and
  token-account owners (the multi-token path). There is no per-token
  exclusions file.

## Wrapped / bridged tokens (`chains[].bridge`, `origin`)

This follows CoinGecko and the other aggregators: a token has **one** total and
circulating supply, and the per-chain figures add up to it. There is no
separate "wrapped" product. Each non-origin chain declares how its supply
exists:

| `bridge` | Meaning | Counts toward total |
|---|---|---|
| `native` (default) | independently minted on that chain (e.g. native USDC) | yes, its full supply |
| `burn-mint` | bridge burns on one side and mints on the other | yes, its full supply |
| `lock-mint` | mirror of tokens locked on the origin chain | **no**, the locked origin balance backs it |

Exactly one chain may set `"origin": true`. A `lock-mint` chain requires an
origin, and the origin should list its lock contracts in `contracts{}` with
`role: "bridge"` or `"escrow"` (validation warns otherwise).

`scripts/lib/supply.js` `computeBridgeNettedSupply` (selected by
`selectSupplyMethod`):

- `total` = origin supply + Σ supply of `native` / `burn-mint` chains.
- `nonCirculating` = the balance on the origin of the lock set (exclusion
  labels `bridge-lock` / `escrow`, plus origin `contracts{}` with role
  `bridge` / `escrow`); `circulating` = `total` − `nonCirculating`.
- `byChain` shares add up to `total`. A lock-mint mirror's own supply is shown
  on its chain, and the locked balance is taken off the origin.
- `backingResidual` = Σ lock-mint supply − locked. Above 1% it logs a warning
  (an unlabelled lock, or a bridge minting more than is locked).
- The `supply.target` tolerance check runs only when `supply.target` is set.
- No origin and only native chains (e.g. a Solana-only token): the chain
  supplies are summed.

`contracts{}` entries with role `bridge`, `escrow`, `cex`, `dex` or `staking`
are non-retail on their chain for generic projects
(`projectNonRetailPaths().extraAddresses`). On Solana, list the **owner**
(wallet or PDA) address. `reconcileSupply` understands bridge-netting snapshots:
only lock-mint chains are mirrors, and other non-origin chains count as their
own supply.

**TEL is untouched.** It keeps `supply.generationsSumOneToOne` and the
generations path (`computeSupplyTotals`, method `tel-generations`), and its
non-retail paths and feed outputs are byte-identical (`bridgeNetting.test.js`,
`solanaFeeds.test.js`, `projectValidation.test.js`).

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
| CEX balance / Dune query | Per-project query | A new project needs its own Dune query id. The current Dune key keeps being used. Solana: see "Solana CEX wallets" below. |

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

## Feed health (`health`)

`npm run pipeline:health` and `npm run check:feeds` run across every project in `config/projects.json`
(`--project <slug>` for one). Defaults live in `scripts/lib/feedHealth.js`; a project overrides them in
its config, so onboarding a token needs no code change:

```json
"health": {
  "feeds": {
    "holders-lite.json":    { "maxAgeHours": 36 },
    "tier-outflows.json":   { "placeholder": true },
    "funding-wallets.json": { "disabled": true }
  },
  "consistency": { "maxHolderChangePct": 2, "knownHolderChangeDates": ["2026-10-03"] }
}
```

* `placeholder: true` marks an intentional stub (e.g. a flow scanner not built for that chain): reported
  as PLACEHOLDER, never stale, and checked only to be no older than the holders snapshot. The
  exchange-flow and tier-flow panels read the same flag: a placeholder `exchange-flow-history.json` /
  `tier-outflows.json` shows "flow tracking isn't available for {ticker} yet" (override with
  `copy.text["flows.unavailable"]`) instead of "no data for this period".
* Flow feeds mark the in-progress UTC day: `partial: true` on the last `exchange-flow-history.json`
  entry and `partialDate` in `tier-outflows.json`. The UI keeps it out of totals/charts (exchange net
  flow) or labels the 1D window "so far today"; feeds without the field read as settled.
* `disabled: true` drops a default feed the project does not produce.
* `check-feed-consistency` WARNs (never fails) when the combined holder count moves more than
  `maxHolderChangePct` day over day within 30 days; changelog event dates are allowed automatically.
* `pipeline-watchdog.yml` runs daily, checks all projects, and also files an issue when a data
  workflow's latest run failed with zero completed steps (Actions billing block). It cannot run while
  Actions itself is blocked; run `npm run pipeline:health` from outside Actions for that case.

## Adding the next project

1. Add `{ "slug": "<slug>", "name": "...", "ticker": "..." }` to `config/projects.json`.
   Slugs are lowercase `[a-z0-9-]`.
2. Add `config/projects/<slug>.json` using `tel.json` as the template. Use only
   verified addresses, never guessed ones. Run
   `node scripts/detect-token-chains.js --address 0x… --chain <origin> --ticker <T> --coingecko`
   first so `chains[]` includes every chain the token is on (see "Chain
   discovery"). Each extra chain gets a picker view automatically.
   For each extra chain, confirm `bridge` (`native` / `lock-mint` / `burn-mint`)
   from the project's bridge docs and mark the `origin`. Add a Solana chain
   only if the token is actually deployed there (see "Solana chains").
3. Cache the token's CoinGecko coin image (build time only, never fetched by
   the browser): read `image.large` from
   `https://api.coingecko.com/api/v3/coins/<coingecko-id>`, download it without
   its `?…` query to `public/tokens/<slug>.<png|jpg>` in its original format,
   and set `"image": "/tokens/<slug>.<ext>"` in `config/projects/<slug>.json`.
   CSP `img-src` stays `'self'`. Then run `npx tsx scripts/generate-sitemap.ts`
   so the sitemap lists `/<slug>`.
4. Put the browser feeds in `public/data/<slug>/` (same file names as TEL, see
   `BROWSER_DATA_FILES` in `scripts/lib/browserDataFiles.js`). Ported pipeline
   scripts write there when run with `--project <slug>`. Give the config
   `supply.target`, `staking[].kind` / `deployBlock` and its own
   `classification.*` files.
5. Nothing to do for `netlify/functions/live-data.mjs`: it reads the slugs from `config/projects.json` (only a `legacyRoot` project needs `"legacyRoot": true` on its registry entry).
   A test fails if it is missing.
6. Optional: add a `holders` block if TEL's tier sizes don't fit the supply, and
   `chains[].rpc` for chains other than ethereum, polygon and base (Solana:
   `SOLANA_RPC_0..9` if public RPC refuses the holder scan).
7. Optional: add `copy` overrides for wording the generic templates get wrong.
8. Run `npm run typecheck && npx vitest run && npm run build`.

The landing page and the sitemap pick the new project up automatically.

## Solana CEX wallets

Dune's `cex.addresses` carries Solana rows (`blockchain = 'solana'`, base58
`address`). A Solana project's Dune query must select only those:

```sql
SELECT blockchain, address, cex_name, distinct_name
FROM cex.addresses
WHERE blockchain = 'solana'
```

Save it in Dune and set its id as `pipeline.duneCexQueryId` (never TEL's
3761086). Until a query exists, `sync-cex-wallets-dune --project <slug>
--candidates --source spellbook` produces the same labels from the public
spellbook model with no API key. Either way the output is a candidates file
(`data/<slug>/cex-dune-candidates.json`); promotion into a
`classification.cexWallets` file is an owner decision. ZBCN status:
`docs/zbcn-cex-candidates.md` and `docs/zbcn-wallet-candidates.md`. The 44
wallets are applied. `pipeline.duneCexQueryId` is still unset.

## Solana venue flows

Solana has no Transfer-log range scan, so flows are **venue-anchored**.
`node scripts/scan-solana-flows.js --project <slug>` needs only config: every
`chains[].vm "solana"` chain (mint and `decimals` from `tokens[]`), the CEX list
`classification.cexWallets`, `contracts{}` entries with role `dex` /
`staking` (plus optional `classification.dexContracts` pools and the
`solana-staking.json` vaults). A second Solana token needs a project config and
nothing else.

- **Discovery:** for each CEX/DEX owner, `getTokenAccountsByOwner(mint)` then
  `getSignaturesForAddress` per token account (paged with `before`, stopped by
  `until` = the account cursor) then `getTransaction` (`jsonParsed`). Per-owner
  mint deltas (`tokenFlows.js`) are paired into transfers and classified:
  `cexIn` / `cexOut` (against the named exchange), `dexIn` / `dexOut` (pool vs
  a non-CEX), `internal` (CEX to CEX, never in net) and `staking` (either side
  is a staking or reward vault, matched by owner or by listed token account;
  classified, not an exchange flow).
- **Resume and budget:** signatures from all accounts are merged and processed
  oldest first in whole-slot steps, at most `--max-tx` / `SOLANA_FLOW_MAX_TX`
  (default 3000) per run; each account cursor advances to its newest processed
  signature, a transaction touching two venue accounts is counted once, and a
  re-run with nothing new changes no file. `SOLANA_FLOW_CONCURRENCY` (default 4)
  bounds parallel `getTransaction`; 429s use the shared `rpcCall` backoff. The
  floor is `--since` / `SOLANA_FLOWS_SINCE` / the first committed holder
  snapshot date (ZBCN: 2026-10-25); nothing earlier is ever invented.
- **Files:** `public/data/<slug>/exchange-flow-checkpoint.json`
  (`chains.<key>`: `mint`, `since`, `accounts{tokenAccount:{owner,until}}`,
  `complete`, `missingTx`) and the unserved day store
  `data/<slug>/solana-flow-days.json` (exact raw sums per day, kind, exchange
  and counterparty). A cursor whose day store is missing is discarded and
  re-scanned, never trusted.
- **Feeds:** `scan-exchange-flows.js` (no EVM chains) writes
  `exchange-flow-history.json` (schema 3, same fields as TEL) from the store;
  `generate-tier-outflows.js` (no EVM chains) writes the Solana legs of
  `tier-outflows.json` (schema 9). Both publish the still-open UTC day flagged like TEL (`partial: true` on the last exchange row, top-level `partialDate`, via `lib/partialDay.js`),
  and only days on or
  after the first snapshot. A retail counterparty's tier is its balance bucket
  in the latest snapshot on/before the day (staked balances already credited).
- **What is and is not measured:** CEX deposits and withdrawals, pool sales and
  purchases. Wallet-to-wallet moves that touch no tracked venue (`moved`,
  `inflows.wallet`, source/destination tier) are **not** measured and stay 0,
  so `sourceTierSince` is `null`; all pool flow is reported as `dexSwap` (LP
  adds are not told apart). `complete` is `true` once every venue cursor has
  caught up to the tip from the floor, which means the venue legs only.
- **Run order:** `scan-solana-flows.js`, then `scan-exchange-flows.js` and
  `generate-tier-outflows.js`.
- **Not wired yet (workflow follow-up):** in `refresh-zebec-network.yml`
  "Generate feeds", add `node scripts/scan-solana-flows.js` before
  `scan-exchange-flows.js`, give that step `SOLANA_RPC_0: ${{ secrets.SOLANA_RPC_0 }}`
  (and `ENV_PASSPHRASE`), and add `data/solana-flow-days.json` to the
  `workflow-paths.js files` list (the checkpoint is already staged). The public
  RPC rate-limits `getTransaction`; use a keyed endpoint for the first backfill.
