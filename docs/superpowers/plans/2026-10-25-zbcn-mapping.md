# ZBCN (zebec-network) End-to-End Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Zebec Network (ZBCN) as the second project on holderdistribution.com: a Solana-only holder snapshot, forward-only history, a separate Staked tile fed by a `zebecStakeV1` adapter, Solana flow scaffolding, the `?token=zebec-network` switcher entry, a Pipeline QA pass, and one batched PR.

**Architecture:** This builds on PR #40's Solana adapter (`scripts/lib/solana/`). ZBCN is a config-driven project (`config/projects/zebec-network.json`, feeds under `public/data/zebec-network/`). Holders come from one SPL `getProgramAccounts` scan through `pull-holders-rpc --project zebec-network`. Staking comes from a new program-specific decoder (`scripts/lib/solana/zebecStake.js`). It writes `solana-staking.json`, which `generate-holders-lite` loads as a module-wide positions overlay, the same channel TEL's v3 StakingModule uses. Staked tokens therefore never enter retail balances. History grows only from daily snapshots. Flows ship as a tested library plus a dry-run script and stay hidden on the site until CEX wallets are known.

**Tech Stack:** Node 22 ESM scripts, Vitest, React + Vite (TypeScript), Netlify functions, GitHub Actions, Solana JSON-RPC (public first, optional `SOLANA_RPC_0..n`).

## Global Constraints

- Solana-only `chains[]`. Exclude the EVM impostors and the ~21-token Wormhole Base copy.
- Slug `zebec-network`. Do not set it as the default; TEL stays `default: true`.
- Ignore the legacy ZBC mint `zebeczgi5fSEtbpfQKVZKCJ3WgYXxjkMUkNNx7fLKAF`. Do not map it or net it.
- Mint `ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU`, `spl-token`, 6 decimals, `bridge: "native"`, `origin: true`.
- `supply.target` = `100000000000` (100e9). CoinGecko id `zebec-network`.
- Staking program `zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv`, `kind: "zebecStakeV1"`. Staked is shown **separately** from retail and is never added to holder balances.
- Buyback treasury `EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW` (ATA `G3shxzbgWZFLJZTFdysmsK42MTHrZduFuTxxYqwxtgox`) keeps `role: "treasury"` and its source annotation.
- No invented CEX wallets. CEX and flow panels stay hidden for ZBCN until the owner supplies wallets.
- Never lowercase Solana base58. Use `normalizeAddressForVm("solana", …)` or `normalizeAnyAddress`.
- Solana code loads only for projects that list a Solana chain. TEL must never import `scripts/lib/solana/*`.
- `--as-of` backfill is refused for Solana. History starts at the first live snapshot.
- No secrets in git. `SOLANA_RPC_0` goes in a local `.env` (gitignored), `.env.enc`, or GitHub Actions/Netlify secrets.
- One batched PR at the end (Netlify credit cost). No intermediate pushes. Branch `map/zbcn`.
- TEL regression: regenerated TEL feeds must be byte-identical apart from `generatedAt`.

## Status going in (done; do not redo)

| Phase | State | Evidence |
|---|---|---|
| 0 Wireframe | Approved by owner | Panels: headline/supply, distribution+tiers, holder growth (forward), chain tabs Combined+Solana, staked tile, classification/treasury, exchange/flows (later), gated forensics (later) |
| 1 Questionnaire + discovery | Done | `/workspace/zbcn-findings.md`, `/workspace/zbcn-research-brief.md`, `/workspace/zbcn-runs/` (smoke PASS, detect-token-chains candidates `[]`) |
| 1 Owner confirm | `confirm-all-six` | Six defaults above |
| 2 Config | Draft on disk, **uncommitted** | `config/projects/zebec-network.json` (new), `config/projects.json` (registered) in worktree `/workspace/hd-zbcn` |

## Roles

| Role | Owns in this plan |
|---|---|
| **Orchestrator** (Holderdistribution.com chat) | Owner questions/approvals, getting `SOLANA_RPC_0` from the owner, task dispatch, review between tasks, PR open/merge decision, go-live report (Task 12) |
| **Token Mapper** | Tasks 1–9 and 11: config, data layout, adapter, pipeline scripts, local dry-runs, first-refresh feeds, PR mechanics |
| **Pipeline QA** | Task 10 gate (plus spot checks after Tasks 4, 5, 7). Pass/fail with screenshots. Nothing merges without a PASS |

## Blockers (owner/infra; tracked, not code)

1. **`SOLANA_RPC_0`** (Task 4 onward, live runs only). The public `api.mainnet-beta.solana.com` rate-limits `getProgramAccounts` and `getTokenLargestAccounts` (429 seen). The owner must create a free-tier Solana RPC key whose plan allows `getProgramAccounts` (Helius free or Alchemy Solana free both do), then put it in local `/workspace/hd-zbcn/.env` as `SOLANA_RPC_0=https://…` and in GitHub Actions as repo secret `SOLANA_RPC_0`. The Orchestrator asks the owner through an in-chat form. Agents never print or commit the key. Unit tests (Tasks 2, 3, 6, 7, 8) do not need it.
2. **CEX hot wallets**: unknown. Flow panels stay hidden (Task 8). Not a go-live blocker.
3. **zebecStakeV1 adapter**: built in Tasks 6–7. It blocks the Staked tile only. Holders and history can ship first if needed.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `config/projects/zebec-network.json` | Commit draft + add vault entries | Project config |
| `config/projects.json` | Commit draft | Registry entry |
| `netlify/functions/live-data.mjs:37` | Modify | `PROJECT_SLUGS` includes `zebec-network` |
| `scripts/lib/zebecNetworkConfig.test.js` | Create | Locks the six owner choices and the vault classification |
| `public/data/zebec-network/.gitkeep`, `data/zebec-network/.gitkeep` | Create | Data/work dirs |
| `scripts/lib/solana/zebecStake.js` | Create | Decode Lockup / UserStakeData, derive vault PDAs/ATAs, fetch positions, reconcile against vault balances |
| `scripts/lib/solana/zebecStake.test.js` | Create | Decoder/PDA/positions tests (no network) |
| `scripts/pull-solana-staking.js` | Create | CLI `--project <slug>` → `public/data/<slug>/solana-staking.json` |
| `scripts/lib/solanaStaking.js` (+ `.test.js`) | Create | `loadSolanaStakingPositions(feed)` → v3-shaped overlay |
| `scripts/lib/v3Staking.js:19` (+ new `v3Staking.test.js`) | Modify | `normalize` keeps base58 case |
| `scripts/generate-holders-lite.js:81` | Modify | Fall back to the Solana staking overlay |
| `scripts/lib/solana/tokenFlows.js` (+ `.test.js`) | Create | Per-owner mint deltas from a parsed tx + venue classification |
| `scripts/scan-solana-flows.js` | Create | Dry-run scanner → `data/<slug>/solana-flows-sample.json` |
| `src/lib/stakingSplit.ts` (+ `.test.ts`) | Create | Legacy/v3 split sub-label only when both exist |
| `src/components/WalletHoldingsWidget.tsx:780-785` | Modify | Use the helper |
| `.github/workflows/refresh-zebec-network.yml` | Create | Daily Solana-only refresh, shared concurrency group |
| `docs/MULTI-TOKEN.md` | Modify | Document `zebecStakeV1`, `solana-staking.json`, Solana flow scaffold |
| `public/data/zebec-network/*.json` | Generated | First-refresh feeds committed in the batched PR |

---

### Task 1: Preflight and baseline (Token Mapper)

**Files:** none changed.

**Interfaces:**
- Consumes: worktree `/workspace/hd-zbcn` on branch `map/zbcn` (base `143652f`) with the uncommitted config draft.
- Produces: installed deps and a recorded baseline test count.

- [ ] **Step 1: Confirm the worktree and branch**

Run: `cd /workspace/hd-zbcn && git status -sb && git log --oneline -2`
Expected: `## map/zbcn...origin/main`, ` M config/projects.json`, `?? config/projects/zebec-network.json`, with this plan's commit on top of `143652f`.

- [ ] **Step 2: Install deps**

Run: `npm ci`
Expected: exit 0. `node_modules` is not installed in this worktree yet.

- [ ] **Step 3: Baseline tests**

Run: `npx vitest run 2>&1 | tail -15`
Expected: everything passes **except** `scripts/lib/projects.test.js > live-data function constants match the registry`. It fails with `expected [ 'tel' ] to equal [ 'tel', 'zebec-network' ]` because the draft registered the slug and `PROJECT_SLUGS` still reads `["tel"]`. Task 2 fixes it. Record the pass count. Main had 754 after PR #40.

- [ ] **Step 4: Smoke the mint (public RPC, cheap)**

Run: `node scripts/solana-smoke.js --mint ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU --program spl-token`
Expected: `usable RPCs: ≥1`, `decimals: 6`, symbol `ZBCN`.

---

### Task 2: Commit the config, register live-data, lock owner choices (Token Mapper)

**Files:**
- Modify: `netlify/functions/live-data.mjs:37`
- Modify: `config/projects/zebec-network.json` (`chains[0].contracts`: add the stake/reward vault token accounts)
- Commit: `config/projects.json`
- Create: `scripts/lib/zebecNetworkConfig.test.js`

**Interfaces:**
- Consumes: `loadProjectConfig(slug, root)`, `validateProjectConfig(config)`, `projectRoleAddresses(config)` from `scripts/lib/projects.js`.
- Produces: `PROJECT_SLUGS = new Set(["tel", "zebec-network"])`. Vault token accounts carry `role: "staking"`, so `projectNonRetailPaths()` excludes their owners from retail via `extraAddresses` and the adapter's `tokenAccountOwners` map.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/zebecNetworkConfig.test.js`:

```js
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, validateProjectConfig, projectRoleAddresses } from "./projects.js";
import { PROJECT_SLUGS, LEGACY_ROOT_SLUGS } from "../../netlify/functions/live-data.mjs";

const root = path.resolve(".");
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const PROGRAM = "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv";
const STAKE_VAULT_ATAS = [
  "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo",
  "8bbygT4wHaR1vXQMCTK9uVnoDGBwWjNx9BUwjgLtkBvv",
  "7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6",
  "FnJhFWTiYTGSePJDKVNYQgf5XUFBJEk1rvPifj6hvb4Y",
  "BcfMnwQMpv988qVCDMpJhXRyYiqchrYh9pcJPvjEypj4",
];
const REWARD_VAULT_ATAS = ["ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE", "DGMT79t6tVGPHW8gLH29a6G1W8AnWhc5NzddvHiU9kCy"];

describe("zebec-network config (owner choices 2026-10-25)", () => {
  const c = loadProjectConfig("zebec-network", root);

  it("validates with no errors", () => {
    expect(validateProjectConfig(c).errors).toEqual([]);
  });

  it("is Solana-only, native origin, exact-case mint", () => {
    expect(c.chains.map((x) => x.key)).toEqual(["solana"]);
    const sol = c.chains[0];
    expect(sol).toMatchObject({ vm: "solana", bridge: "native", origin: true });
    expect(sol.tokens).toEqual([expect.objectContaining({ address: MINT, program: "spl-token", decimals: 6, status: "canonical" })]);
  });

  it("supply target 100e9, coingecko zebec-network, not default", () => {
    expect(c.supply.target).toBe(100e9);
    expect(c.gated.walletFlows.coingeckoId).toBe("zebec-network");
    expect(c.default).toBeUndefined();
  });

  it("staking: one zebecStakeV1 entry on the program", () => {
    expect(c.staking).toEqual([expect.objectContaining({ chain: "solana", address: PROGRAM, kind: "zebecStakeV1" })]);
  });

  it("stake + reward vault token accounts are non-retail (role staking)", () => {
    const staking = (projectRoleAddresses(c).staking ?? []).map((e) => e.address);
    for (const a of [...STAKE_VAULT_ATAS, ...REWARD_VAULT_ATAS]) expect(staking).toContain(a);
  });

  it("buyback treasury kept with its annotation; legacy ZBC not mapped", () => {
    const t = c.chains[0].contracts.buybackTreasury;
    expect(t).toMatchObject({ address: "EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW", role: "treasury" });
    expect(t.$comment).toMatch(/G3shxzbgWZFLJZTFdysmsK42MTHrZduFuTxxYqwxtgox/);
    expect(JSON.stringify(c.chains)).not.toContain("zebeczgi5fSEtbpfQKVZKCJ3WgYXxjkMUkNNx7fLKAF");
  });

  it("live-data serves it from public/data/zebec-network", () => {
    expect(PROJECT_SLUGS.has("zebec-network")).toBe(true);
    expect(LEGACY_ROOT_SLUGS.has("zebec-network")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run scripts/lib/zebecNetworkConfig.test.js`
Expected: FAIL on "stake + reward vault token accounts" (no vault entries yet) and "live-data serves it" (`PROJECT_SLUGS` lacks the slug). If `projectRoleAddresses` groups by a key other than `staking`, read `scripts/lib/projects.js:212-235` and use the key it actually returns.

- [ ] **Step 3: Implement**

`netlify/functions/live-data.mjs` line 37:

```js
export const PROJECT_SLUGS = new Set(["tel", "zebec-network"]);
```

In `config/projects/zebec-network.json`, add these to `chains[0].contracts` after `buybackTreasury`. The addresses come from `/workspace/zbcn-research-brief.md`. The stake-vault ATAs were re-derived from the lockup PDAs with the repo's `findProgramAddress` and match:

```json
"stakeVaultLockup003": { "address": "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo", "role": "staking", "$comment": "Stake vault ATA of ZBCN_Lockup_003 6ucsPuczmg9uoq5i4SYDEEJ4ciKnuxW3za2sdBcKHwmw (vault PDA HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp)" },
"stakeVaultLockup005": { "address": "8bbygT4wHaR1vXQMCTK9uVnoDGBwWjNx9BUwjgLtkBvv", "role": "staking", "$comment": "Stake vault ATA of ZBCN_Lockup_005 BkdevFCTJvSVXBhE8NEzPFpSFdTvn9pm4zVSsLvW9ZA (vault PDA 5Fe1JVUkaHVEAQ8sZ71xmQdyVahwfeuP4s9TGZ9mf8vk)" },
"stakeVaultLockup": { "address": "7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6", "role": "staking", "$comment": "Stake vault ATA of ZBCN Lockup AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp (vault PDA DWwty3vnpMWsJagibYWPNmJ2BGELHow4vKm5nK79btoC)" },
"stakeVaultLockup002": { "address": "FnJhFWTiYTGSePJDKVNYQgf5XUFBJEk1rvPifj6hvb4Y", "role": "staking", "$comment": "Stake vault ATA of ZBCN_Lockup_002 CuQBm9zdgMFw1BNcfNjb5FA1Di3z4W9AxmDuXfk8kGNU" },
"stakeVaultLockup004": { "address": "BcfMnwQMpv988qVCDMpJhXRyYiqchrYh9pcJPvjEypj4", "role": "staking", "$comment": "Stake vault ATA of ZBCN_Lockup_004 DxdP5pM5BSD38C7s43aYV2BHUfKLJZq1P5673AT87HPn" },
"rewardVaultA": { "address": "ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE", "role": "staking", "$comment": "Staking reward vault ATA (research brief)" },
"rewardVaultB": { "address": "DGMT79t6tVGPHW8gLH29a6G1W8AnWhc5NzddvHiU9kCy", "role": "staking", "$comment": "Staking reward vault ATA (research brief)" }
```

Also set `pipelineNotes.liveData` to `"Registered in PROJECT_SLUGS (netlify/functions/live-data.mjs)."`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run scripts/lib/zebecNetworkConfig.test.js scripts/lib/projects.test.js scripts/lib/projectValidation.test.js scripts/lib/liveDataFunction.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add config/projects.json config/projects/zebec-network.json netlify/functions/live-data.mjs scripts/lib/zebecNetworkConfig.test.js
git commit -m "feat(zbcn): register zebec-network config, live-data slug, vault classification"
```

---

### Task 3: Data layout (Token Mapper)

**Files:**
- Create: `public/data/zebec-network/.gitkeep`, `data/zebec-network/.gitkeep`

**Interfaces:**
- Consumes: `projectDataDir("zebec-network")` = `public/data/zebec-network`; `projectWorkDir` = `data/zebec-network`.
- Produces: the directories that every later script writes into. Feed names are the shared `BROWSER_DATA_FILES` set, so nothing new is served.

- [ ] **Step 1: Verify the path resolver output (acts as the test)**

Run: `HD_PROJECT=zebec-network node scripts/workflow-paths.js`
Expected: `HD_PROJECT_SLUG=zebec-network`, `HD_LEGACY_ROOT=false`, `HD_DATA_DIR=public/data/zebec-network`, `HD_WORK_DIR=data/zebec-network`, `HD_CEX_CONFIG=` (empty).

- [ ] **Step 2: Create the dirs**

```bash
mkdir -p public/data/zebec-network data/zebec-network
touch public/data/zebec-network/.gitkeep data/zebec-network/.gitkeep
```

- [ ] **Step 3: Regression**

Run: `npx vitest run scripts/lib/browserDataFiles.test.js scripts/lib/projects.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add public/data/zebec-network/.gitkeep data/zebec-network/.gitkeep
git commit -m "chore(zbcn): data and work dirs for zebec-network"
```

---

### Task 4: First holder snapshot (Token Mapper; **needs SOLANA_RPC_0**)

**Files:**
- Generated under `public/data/zebec-network/` (holder snapshot, `holders-checkpoint.json`, `chain-status.json`) and `data/zebec-network/`.

**Interfaces:**
- Consumes: `solanaAdapter.scanChain(chain)` (PR #40) via `pull-holders-rpc.js --project zebec-network`.
- Produces: the snapshot that Tasks 5 and 7 read. Each owner is base58 exact. Vault/treasury owners are classified through `tokenAccountOwners`.

- [ ] **Step 1: Orchestrator gets the key**

The Orchestrator asks the owner, through an in-chat form (`in-chat-forms` skill), for a free-tier Solana RPC URL. Token Mapper writes it into `/workspace/hd-zbcn/.env` as `SOLANA_RPC_0=…`. Verify that `git check-ignore .env` prints `.env`.

- [ ] **Step 2: Full scan smoke**

Run: `node scripts/solana-smoke.js --mint ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU --program spl-token --scan`
Expected: `holders:` roughly 100,000–125,000 (Solscan showed ~111K), `supply: ~99998768619`, and a slot. If it throws `incomplete scan; refusing to publish`, the provider truncated `getProgramAccounts`. Switch providers and do **not** loosen `SNAPSHOT_SUPPLY_TOLERANCE`.

- [ ] **Step 3: Pipeline snapshot**

Run: `node scripts/pull-holders-rpc.js --project zebec-network 2>&1 | tee data/zebec-network/first-scan.log`
Expected: `[pull-holders-rpc] project: zebec-network (public/data/zebec-network)` and `solana: N holders (… token accounts, … empty) for ZBCN [spl-token] at slot S`. No staker merge happens, because there is no `stakeChanged` entry. Exit 0.

- [ ] **Step 4: TEL files untouched**

Run: `git status --porcelain -- 'public/data/*.json' 'data/*.json'`
Expected: empty.

- [ ] **Step 5: Classification spot check**

```bash
node -e '
const s=require("./public/data/zebec-network/holders-checkpoint.json");
const b=s.chains?.solana?.balances||{};
for (const a of ["HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp","5Fe1JVUkaHVEAQ8sZ71xmQdyVahwfeuP4s9TGZ9mf8vk","EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW"]) console.log(a, b[a] ?? "(absent)");'
```
Expected: the vault PDAs hold ~4.07B and ~544M, and the treasury holds ~108M. If the checkpoint keys balances differently, read the checkpoint write in `scripts/pull-holders-rpc.js` and adjust **this command only**.

- [ ] **Step 6: Commit (local only)**

```bash
git add public/data/zebec-network data/zebec-network
git commit -m "data(zbcn): first Solana holder snapshot"
```

---

### Task 5: Lite feed + forward-only history + transitions + supply (Token Mapper)

**Files:**
- Generated: `public/data/zebec-network/holders-lite.json`, `holders-summary.json`, `holders-history.json`, `holder-transitions.json`, `supply-reconciliation.json`, `treasury-history.json`, `classification-changelog.json`
- Test (only if the gap check fails): `scripts/lib/solanaFeeds.test.js`

**Interfaces:**
- Consumes: the Task 4 snapshot.
- Produces: `views.combined` + `views.solana` in `holders-lite.json`, and the first `holders-history.json` row with `chains.solana`.

- [ ] **Step 1: Gap check for Solana history coverage**

Run: `npx vitest run scripts/lib/solanaFeeds.test.js -t history`
Expected: at least one passing test that asserts a history row with `chains.solana`. If none matches, add a test to `scripts/lib/solanaFeeds.test.js`. Build a two-holder Solana snapshot the same way the existing tests in that file do, then call `reconcileHistoryEntry` from `./holderHistoryReconcile.js` with its documented input. Assert `Object.keys(entry.chains)` equals `["solana"]` and that holder counts match. Run it, watch it fail if code is missing, and fix only `scripts/generate-holders-history.js`/`holderHistoryReconcile.js`.

- [ ] **Step 2: Generate**

```bash
export HD_PROJECT=zebec-network
node scripts/generate-holders-lite.js
node scripts/generate-holders-history.js
node scripts/generate-holder-transitions.js
node scripts/reconcile-supply.js
node scripts/append-treasury-history.js
node scripts/sync-classification-changelog.js
unset HD_PROJECT
```
Expected: each prints `project: zebec-network`. `holders-lite.json` has `chainOrder: ["solana"]` and `views.solana`, and retail excludes the vault PDAs and the treasury. `holders-history.json` has one dated row, and `holder-transitions.json` has a zero-delta first day. If any script exits 2 with `is not ported`, stop and report it to the Orchestrator rather than porting silently.

- [ ] **Step 3: Validate feeds**

Run: `HD_PROJECT=zebec-network npm run check:feeds`
Expected: exit 0. Supply ≈ 99.999B against the 100e9 target. The ~1.23M burned shows as target − supply, not as an error.

- [ ] **Step 4: Confirm `--as-of` is refused (history is forward-only)**

Run: `node scripts/pull-holders-rpc.js --project zebec-network --as-of=2026-10-01; echo "exit=$?"`
Expected: a message containing `--as-of is not supported for Solana chains (solana)` and a non-zero exit.

- [ ] **Step 5: Commit**

```bash
git add public/data/zebec-network scripts/lib/solanaFeeds.test.js
git commit -m "data(zbcn): lite, history (forward-only), transitions, supply feeds"
```

Pipeline QA spot check: `views.solana.metrics.retail` excludes the ~4.79B staked and the ~108M treasury.

---

### Task 6: `zebecStakeV1` adapter (Token Mapper; TDD)

**Files:**
- Create: `scripts/lib/solana/zebecStake.js`
- Test: `scripts/lib/solana/zebecStake.test.js`

**Interfaces:**
- Consumes: `findProgramAddress(seeds, programId)` from `scripts/lib/solana/pda.js`; `base58Decode`/`base58Encode` from `scripts/lib/address.js`; `rawToNumber`, `PROGRAM_BY_NAME` from `scripts/lib/solana/metadata.js`; a failover-bound `call(method, params)`.
- Produces:
  - `decodeUserStakeData(buf: Buffer) → { nonce: bigint, createdTime: number, stakedRaw: bigint, rewardRaw: bigint, claimed: boolean, lockPeriod: number, staker: string, lockup: string }`
  - `decodeLockup(buf: Buffer) → { name, creator, minimumStake: bigint, durations: {duration:number,reward:number}[], rewardToken, stakedToken, totalStakedRaw: bigint, fee: bigint, feeVault }`
  - `stakeVaultPda(lockup: string, programId?) → string`; `associatedTokenAddress(owner, mint, tokenProgramId?) → string`
  - `fetchZebecStakePositions(call, { programId, mint, decimals, logger }) → Promise<{ programId, mint, lockups: Array<{address,name,stakeVault,stakeVaultAta,activeRaw:string,vaultRaw:string|null,totalStakedRaw:string}>, positions: Array<{staker:string, raw:string, amount:number}>, stakerCount:number, positionCount:number, stakedRaw:string, stakedTotal:number }>`

IDL facts (Anchor; `@zebec-network/zebec-stake-sdk@1.3.5` `dist/artifacts/zebec_stake_v1.json`):
- `Lockup` discriminator `[1,45,32,32,57,81,88,67]`. Fields: `stake_info{name:string, creator:pubkey, minimum_stake:u64, duration_map:vec<{duration:u64,reward:u64}>}`, `reward_token{token_address}`, `staked_token{token_address, total_staked:u64}`, `fee_info{fee:u64, fee_vault:pubkey}`.
- `UserStakeData` discriminator `[105,207,3,141,114,114,232,147]`: `nonce u64 @8`, `created_time i64 @16`, `staked_amount u64 @24`, `reward_amount u64 @32`, `stake_claimed bool @40`, `lock_period i64 @41`, `staker pubkey @49`, `lockup pubkey @81` (113 bytes used).
- Seeds: `stake_vault = ["stake_vault", lockup]`. The vault token account is the ATA of `stake_vault` for the mint. Verified: lockup `6ucsPucz…` → PDA `HJqK7re4…` → ATA `3DC8cdCN…`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/solana/zebecStake.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { base58Decode, base58Encode } from "../address.js";
import {
  LOCKUP_DISCRIMINATOR,
  USER_STAKE_DATA_DISCRIMINATOR,
  ZEBEC_STAKE_V1_PROGRAM,
  associatedTokenAddress,
  decodeLockup,
  decodeUserStakeData,
  fetchZebecStakePositions,
  stakeVaultPda,
} from "./zebecStake.js";

const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const LOCKUP_003 = "6ucsPuczmg9uoq5i4SYDEEJ4ciKnuxW3za2sdBcKHwmw";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const silent = { log: vi.fn(), warn: vi.fn() };

const u64 = (v) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(v); return x; };
const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v); return x; };

const userStake = ({ staker, lockup, staked, claimed = false }) => {
  const b = Buffer.alloc(113);
  Buffer.from(USER_STAKE_DATA_DISCRIMINATOR).copy(b, 0);
  b.writeBigUInt64LE(1n, 8);
  b.writeBigInt64LE(1767225600n, 16);
  b.writeBigUInt64LE(staked, 24);
  b.writeBigUInt64LE(0n, 32);
  b[40] = claimed ? 1 : 0;
  b.writeBigInt64LE(7776000n, 41);
  Buffer.from(base58Decode(staker)).copy(b, 49);
  Buffer.from(base58Decode(lockup)).copy(b, 81);
  return b;
};

const lockupAcc = ({ name, stakedToken, totalStaked }) => {
  const nameBuf = Buffer.from(name, "utf8");
  return Buffer.concat([
    Buffer.from(LOCKUP_DISCRIMINATOR),
    u32(nameBuf.length), nameBuf,
    Buffer.from(base58Decode(ALICE)),      // creator
    u64(1000000n),                          // minimum_stake
    u32(1), u64(7776000n), u64(5n),         // duration_map: [{7776000, 5}]
    Buffer.from(base58Decode(stakedToken)), // reward_token
    Buffer.from(base58Decode(stakedToken)), // staked_token.token_address
    u64(totalStaked),                       // staked_token.total_staked
    u64(0n),                                // fee
    Buffer.from(base58Decode(BOB)),         // fee_vault
  ]);
};

const row = (pubkey, buf) => ({ pubkey, account: { data: [buf.toString("base64"), "base64"] } });

describe("zebecStakeV1 decoding", () => {
  it("decodes UserStakeData at the IDL offsets", () => {
    const d = decodeUserStakeData(userStake({ staker: ALICE, lockup: LOCKUP_003, staked: 2_500_000_000_000n }));
    expect(d).toMatchObject({ staker: ALICE, lockup: LOCKUP_003, stakedRaw: 2_500_000_000_000n, claimed: false, lockPeriod: 7776000 });
  });

  it("rejects a wrong discriminator", () => {
    const b = userStake({ staker: ALICE, lockup: LOCKUP_003, staked: 1n });
    b[0] = 0;
    expect(() => decodeUserStakeData(b)).toThrow(/not a UserStakeData/);
  });

  it("decodes a Lockup (variable-length name + duration map)", () => {
    const l = decodeLockup(lockupAcc({ name: "ZBCN_Lockup_003", stakedToken: MINT, totalStaked: 42n }));
    expect(l).toMatchObject({ name: "ZBCN_Lockup_003", stakedToken: MINT, totalStakedRaw: 42n, feeVault: BOB });
    expect(l.durations).toEqual([{ duration: 7776000, reward: 5 }]);
  });
});

describe("zebecStakeV1 PDAs (verified against the mainnet research brief)", () => {
  it("stake vault PDA and its ZBCN ATA for ZBCN_Lockup_003", () => {
    const vault = stakeVaultPda(LOCKUP_003);
    expect(vault).toBe("HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp");
    expect(associatedTokenAddress(vault, MINT)).toBe("3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo");
  });
});

describe("fetchZebecStakePositions", () => {
  const vaultAta = "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo";
  const makeCall = (vaultAmount) =>
    vi.fn(async (method, params) => {
      if (method === "getProgramAccounts") {
        const filters = params[1].filters;
        const disc = filters.find((f) => f.memcmp?.offset === 0).memcmp.bytes;
        if (disc === base58Encode(LOCKUP_DISCRIMINATOR)) {
          return [
            row(LOCKUP_003, lockupAcc({ name: "ZBCN_Lockup_003", stakedToken: MINT, totalStaked: 3_000_000n })),
            row(BOB, lockupAcc({ name: "other-mint", stakedToken: ALICE, totalStaked: 9n })), // different staked token: ignored
          ];
        }
        expect(filters.find((f) => f.memcmp?.offset === 81).memcmp.bytes).toBe(LOCKUP_003);
        return [
          row("p1", userStake({ staker: ALICE, lockup: LOCKUP_003, staked: 2_000_000n })),
          row("p2", userStake({ staker: ALICE, lockup: LOCKUP_003, staked: 500_000n })),
          row("p3", userStake({ staker: BOB, lockup: LOCKUP_003, staked: 500_000n })),
          row("p4", userStake({ staker: BOB, lockup: LOCKUP_003, staked: 9_999_999n, claimed: true })), // unstaked: excluded
        ];
      }
      if (method === "getTokenAccountBalance") {
        expect(params[0]).toBe(vaultAta);
        return { value: { amount: String(vaultAmount) } };
      }
      throw new Error(`unexpected ${method}`);
    });

  it("sums active (unclaimed) positions per staker, case-exact, reconciled with the vault", async () => {
    const r = await fetchZebecStakePositions(makeCall(3_000_000n), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent });
    expect(r.positions).toEqual([
      { staker: ALICE, raw: "2500000", amount: 2.5 },
      { staker: BOB, raw: "500000", amount: 0.5 },
    ]);
    expect(r).toMatchObject({ stakerCount: 2, positionCount: 3, stakedRaw: "3000000", stakedTotal: 3 });
    expect(r.lockups).toEqual([expect.objectContaining({ address: LOCKUP_003, stakeVaultAta: vaultAta, activeRaw: "3000000", vaultRaw: "3000000" })]);
  });

  it("throws when positions and the vault disagree by more than 0.5%", async () => {
    await expect(
      fetchZebecStakePositions(makeCall(4_000_000n), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent }),
    ).rejects.toThrow(/disagree/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/lib/solana/zebecStake.test.js`
Expected: FAIL with `Failed to resolve import "./zebecStake.js"`.

- [ ] **Step 3: Implement**

Create `scripts/lib/solana/zebecStake.js`:

```js
/**
 * Zebec SuperApp staking (Anchor program zebec_stake; IDL from
 * @zebec-network/zebec-stake-sdk@1.3.5). staking[].kind = "zebecStakeV1".
 * Imported only by scripts/pull-solana-staking.js for a project whose
 * staking[] lists this kind, so EVM-only projects never load it.
 *
 * Positions = every UserStakeData with stake_claimed == false, summed per
 * staker. Each lockup's sum is reconciled against its stake-vault token
 * account (ATA of PDA ["stake_vault", lockup]); a gap above
 * STAKE_VAULT_TOLERANCE throws rather than publishing a partial staked total.
 */
import { base58Decode, base58Encode } from "../address.js";
import { findProgramAddress } from "./pda.js";
import { PROGRAM_BY_NAME, rawToNumber } from "./metadata.js";

export const ZEBEC_STAKE_V1_PROGRAM = "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const LOCKUP_DISCRIMINATOR = Uint8Array.of(1, 45, 32, 32, 57, 81, 88, 67);
export const USER_STAKE_DATA_DISCRIMINATOR = Uint8Array.of(105, 207, 3, 141, 114, 114, 232, 147);
export const USER_STAKE_DATA_MIN_SIZE = 113;
export const USER_STAKE_LOCKUP_OFFSET = 81;
export const STAKE_VAULT_TOLERANCE = 0.005;

const hasDisc = (buf, disc) => buf.length >= 8 && disc.every((b, i) => buf[i] === b);
const pubkeyAt = (buf, off) => base58Encode(new Uint8Array(buf.subarray(off, off + 32)));
const fromBase64Account = (account) => Buffer.from(account?.data?.[0] ?? "", "base64");

export function decodeUserStakeData(buf) {
  if (!hasDisc(buf, USER_STAKE_DATA_DISCRIMINATOR)) throw new Error("not a UserStakeData account");
  if (buf.length < USER_STAKE_DATA_MIN_SIZE) throw new Error(`UserStakeData too short: ${buf.length} bytes`);
  return {
    nonce: buf.readBigUInt64LE(8),
    createdTime: Number(buf.readBigInt64LE(16)),
    stakedRaw: buf.readBigUInt64LE(24),
    rewardRaw: buf.readBigUInt64LE(32),
    claimed: buf[40] === 1,
    lockPeriod: Number(buf.readBigInt64LE(41)),
    staker: pubkeyAt(buf, 49),
    lockup: pubkeyAt(buf, USER_STAKE_LOCKUP_OFFSET),
  };
}

export function decodeLockup(buf) {
  if (!hasDisc(buf, LOCKUP_DISCRIMINATOR)) throw new Error("not a Lockup account");
  let o = 8;
  const nameLen = buf.readUInt32LE(o);
  o += 4;
  const name = buf.subarray(o, o + nameLen).toString("utf8");
  o += nameLen;
  const creator = pubkeyAt(buf, o);
  o += 32;
  const minimumStake = buf.readBigUInt64LE(o);
  o += 8;
  const mapLen = buf.readUInt32LE(o);
  o += 4;
  const durations = [];
  for (let i = 0; i < mapLen; i++) {
    durations.push({ duration: Number(buf.readBigUInt64LE(o)), reward: Number(buf.readBigUInt64LE(o + 8)) });
    o += 16;
  }
  const rewardToken = pubkeyAt(buf, o);
  o += 32;
  const stakedToken = pubkeyAt(buf, o);
  o += 32;
  const totalStakedRaw = buf.readBigUInt64LE(o);
  o += 8;
  const fee = buf.readBigUInt64LE(o);
  o += 8;
  const feeVault = pubkeyAt(buf, o);
  return { name, creator, minimumStake, durations, rewardToken, stakedToken, totalStakedRaw, fee, feeVault };
}

export function stakeVaultPda(lockup, programId = ZEBEC_STAKE_V1_PROGRAM) {
  return findProgramAddress([Buffer.from("stake_vault"), base58Decode(lockup)], programId)[0];
}

export function associatedTokenAddress(owner, mint, tokenProgramId = PROGRAM_BY_NAME["spl-token"]) {
  return findProgramAddress([base58Decode(owner), base58Decode(tokenProgramId), base58Decode(mint)], ASSOCIATED_TOKEN_PROGRAM)[0];
}

const gpa = (call, programId, filters) =>
  call("getProgramAccounts", [programId, { encoding: "base64", commitment: "finalized", filters }]);

export async function fetchZebecStakePositions(call, { programId = ZEBEC_STAKE_V1_PROGRAM, mint, decimals, logger = console }) {
  const lockupRows = await gpa(call, programId, [{ memcmp: { offset: 0, bytes: base58Encode(LOCKUP_DISCRIMINATOR) } }]);
  const lockups = [];
  for (const r of lockupRows ?? []) {
    let l;
    try {
      l = decodeLockup(fromBase64Account(r.account));
    } catch (err) {
      logger.warn?.(`  zebecStakeV1: skipping lockup ${r.pubkey}: ${err.message}`);
      continue;
    }
    if (l.stakedToken !== mint) continue;
    const stakeVault = stakeVaultPda(r.pubkey, programId);
    lockups.push({ address: r.pubkey, name: l.name, totalStakedRaw: l.totalStakedRaw, stakeVault, stakeVaultAta: associatedTokenAddress(stakeVault, mint) });
  }

  const perStaker = new Map();
  let positionCount = 0;
  let stakedRaw = 0n;
  for (const lk of lockups) {
    const rows = await gpa(call, programId, [
      { memcmp: { offset: 0, bytes: base58Encode(USER_STAKE_DATA_DISCRIMINATOR) } },
      { memcmp: { offset: USER_STAKE_LOCKUP_OFFSET, bytes: lk.address } },
    ]);
    let active = 0n;
    for (const r of rows ?? []) {
      const p = decodeUserStakeData(fromBase64Account(r.account));
      if (p.claimed || p.stakedRaw === 0n) continue;
      perStaker.set(p.staker, (perStaker.get(p.staker) ?? 0n) + p.stakedRaw);
      active += p.stakedRaw;
      positionCount += 1;
    }
    lk.activeRaw = active;
    lk.vaultRaw = null;
    if (active > 0n) {
      const bal = await call("getTokenAccountBalance", [lk.stakeVaultAta, { commitment: "finalized" }]);
      lk.vaultRaw = BigInt(bal?.value?.amount ?? "0");
      const gap = lk.vaultRaw > active ? lk.vaultRaw - active : active - lk.vaultRaw;
      const ratio = lk.vaultRaw > 0n ? Number(gap) / Number(lk.vaultRaw) : 1;
      if (ratio > STAKE_VAULT_TOLERANCE) {
        throw new Error(
          `zebecStakeV1 lockup ${lk.address} (${lk.name}): vault ${lk.stakeVaultAta} holds ${lk.vaultRaw} raw but active ` +
            `positions sum ${active} raw; they disagree by ${(ratio * 100).toFixed(2)}%, refusing to publish.`,
        );
      }
    }
    stakedRaw += active;
  }

  const positions = [...perStaker.entries()]
    .map(([staker, raw]) => ({ staker, raw: raw.toString(), amount: rawToNumber(raw, decimals) }))
    .sort((a, b) => (BigInt(b.raw) > BigInt(a.raw) ? 1 : BigInt(b.raw) < BigInt(a.raw) ? -1 : 0));

  return {
    programId,
    mint,
    lockups: lockups.map((l) => ({
      address: l.address,
      name: l.name,
      stakeVault: l.stakeVault,
      stakeVaultAta: l.stakeVaultAta,
      activeRaw: l.activeRaw.toString(),
      vaultRaw: l.vaultRaw === null ? null : l.vaultRaw.toString(),
      totalStakedRaw: l.totalStakedRaw.toString(),
    })),
    positions,
    stakerCount: positions.length,
    positionCount,
    stakedRaw: stakedRaw.toString(),
    stakedTotal: rawToNumber(stakedRaw, decimals),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run scripts/lib/solana/zebecStake.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/solana/zebecStake.js scripts/lib/solana/zebecStake.test.js
git commit -m "feat(solana): zebecStakeV1 decoder, vault PDAs, reconciled positions"
```

---

### Task 7: Staking pipeline + separate Staked tile (Token Mapper; TDD)

**Files:**
- Create: `scripts/pull-solana-staking.js`
- Create: `scripts/lib/solanaStaking.js`, `scripts/lib/solanaStaking.test.js`
- Modify: `scripts/lib/projects.js:476-480` (`projectStakingContracts` currently lowercases every address via `lc`, which would corrupt the base58 program id)
- Test: `scripts/lib/projects.test.js` (one new case)
- Modify: `scripts/lib/v3Staking.js:19` (`normalize`)
- Create: `scripts/lib/v3Staking.test.js`
- Modify: `scripts/generate-holders-lite.js` (import + after line 81)
- Create: `src/lib/stakingSplit.ts`, `src/lib/stakingSplit.test.ts`
- Modify: `src/components/WalletHoldingsWidget.tsx:780-785`
- Generated: `public/data/zebec-network/solana-staking.json`. This is pipeline state and is not in `BROWSER_DATA_FILES`, so `prune-dist-data` removes it from `dist/`.

**Interfaces:**
- Consumes: `fetchZebecStakePositions` (Task 6); `projectStakingContracts(project, { kind })`; `solanaBaseToken(chain)`; `configureSolanaChain`, `getUsableSolanaRpcUrls`, `solanaCallWithFailover` from `scripts/lib/solana/rpc.js`.
- Produces: `loadSolanaStakingPositions(feed) → null | { chain: string, modules: [{address,name,deployBlock:null,deployDate:null,lastBlock:number|null}], positions: Map<string, number> }`, with the same shape as `loadV3StakingPositions`. `buildStakingStats(holders, retail, v3)` then counts every staker, including wallets with no liquid ZBCN, in `stakedTotal`/`stakerCount` without touching `balance`/`totalBalance`. That is how staked ≠ retail is enforced.

- [ ] **Step 1: Write the failing tests**

`scripts/lib/solanaStaking.test.js`:

```js
import { describe, expect, it } from "vitest";
import { loadSolanaStakingPositions } from "./solanaStaking.js";

const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";

describe("loadSolanaStakingPositions", () => {
  it("returns null for a missing/empty feed", () => {
    expect(loadSolanaStakingPositions(null)).toBeNull();
    expect(loadSolanaStakingPositions({ positions: [] })).toBeNull();
  });

  it("builds a v3-shaped overlay keyed by exact-case base58", () => {
    const o = loadSolanaStakingPositions({
      chain: "solana",
      programId: "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv",
      name: "Zebec SuperApp staking",
      slot: 123,
      positions: [
        { staker: ALICE, amount: 2.5 },
        { staker: BOB, amount: 0.5 },
        { staker: "not-an-address", amount: 9 },
      ],
    });
    expect(o.chain).toBe("solana");
    expect([...o.positions.entries()]).toEqual([[ALICE, 2.5], [BOB, 0.5]]);
    expect(o.modules).toEqual([
      { address: "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv", name: "Zebec SuperApp staking", deployBlock: null, deployDate: null, lastBlock: 123 },
    ]);
  });
});
```

`scripts/lib/v3Staking.test.js`:

```js
import { describe, expect, it } from "vitest";
import { applyV3Staking, summarizeStaking } from "./v3Staking.js";

const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("v3Staking normalize keeps Solana base58 case", () => {
  it("overlays a Solana position onto the case-exact holder row without changing balances", () => {
    const chains = { solana: { holders: [{ address: ALICE, balance: 10, totalBalance: 10 }] } };
    const v3 = { chain: "solana", modules: [], positions: new Map([[ALICE, 2.5]]) };
    expect(applyV3Staking(chains, v3).solana.holders[0]).toEqual({ address: ALICE, balance: 10, totalBalance: 10, stakedV3Balance: 2.5 });
  });

  it("EVM stays lowercased (TEL unchanged)", () => {
    const chains = { polygon: { holders: [{ address: "0xABCDEF0000000000000000000000000000000001", balance: 1 }] } };
    const v3 = { chain: "polygon", modules: [], positions: new Map([["0xabcdef0000000000000000000000000000000001", 4]]) };
    expect(applyV3Staking(chains, v3).polygon.holders[0].stakedV3Balance).toBe(4);
    expect(summarizeStaking([], v3).v3.stakedTotal).toBe(4);
  });
});
```

`src/lib/stakingSplit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stakingSplitSub } from "./stakingSplit";

const fmt = (n: number) => String(n);

describe("stakingSplitSub", () => {
  it("shows Legacy / v3 only when both channels have stakers (TEL)", () => {
    const both = { legacy: { stakerCount: 3, stakedTotal: 30 }, v3: { stakerCount: 2, stakedTotal: 20 } };
    expect(stakingSplitSub(both, "count", fmt)).toBe("Legacy 3 / v3 2");
    expect(stakingSplitSub(both, "total", fmt)).toBe("Legacy 30 / v3 20");
  });

  it("hides the split for a single-program project (ZBCN: legacy empty)", () => {
    expect(stakingSplitSub({ legacy: { stakerCount: 0, stakedTotal: 0 }, v3: { stakerCount: 5, stakedTotal: 9 } }, "count", fmt)).toBeUndefined();
    expect(stakingSplitSub({ legacy: { stakerCount: 3, stakedTotal: 30 } }, "total", fmt)).toBeUndefined();
  });
});
```

In `scripts/lib/projects.test.js`, add `projectStakingContracts,` to the `./projects.js` import list (lines 5-15), then append this at the end of the file. It uses the file's top-level `root` (line 18):

```js
it("projectStakingContracts keeps Solana base58 case", () => {
  const zbcn = resolveProject("zebec-network", root);
  expect(projectStakingContracts(zbcn, { kind: "zebecStakeV1" })[0].address).toBe("zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/lib/solanaStaking.test.js scripts/lib/v3Staking.test.js src/lib/stakingSplit.test.ts scripts/lib/projects.test.js`
Expected: FAIL. `solanaStaking.js` and `stakingSplit` are unresolved, and the Solana overlay test gets no `stakedV3Balance` because `normalize` lowercases base58.

- [ ] **Step 3: Implement**

`scripts/lib/projects.js` `projectStakingContracts`: lowercase only EVM entries.

```js
export function projectStakingContracts(project, { kind, chain, token } = {}) {
  const vmOf = new Map((project.config?.chains ?? []).map((c) => [c.key, c.vm ?? "evm"]));
  return (project.config?.staking ?? [])
    .filter((s) => (kind ? s.kind === kind : true) && (chain ? s.chain === chain : true) && (token ? s.token === token : true))
    .map((s) => ({ ...s, address: vmOf.get(s.chain) === "solana" ? s.address.trim() : lc(s.address) }));
}
```

`scripts/lib/v3Staking.js`: add the import at the top and replace line 19:

```js
import { normalizeAnyAddress } from "./address.js";

// EVM lowercased (TEL unchanged); Solana base58 kept exact.
const normalize = (value) => (typeof value === "string" ? normalizeAnyAddress(value.trim()) ?? "" : "");
```

`scripts/lib/solanaStaking.js`:

```js
/**
 * Solana program staking overlay (staking[].kind such as "zebecStakeV1").
 * Reads public/data/<slug>/solana-staking.json (scripts/pull-solana-staking.js)
 * into the shape loadV3StakingPositions returns, so buildStakingStats counts
 * every staker while holder balances stay untouched (staked != retail: the
 * tokens sit in program vaults classified role "staking").
 */
import { normalizeAddressForVm } from "./address.js";

export const loadSolanaStakingPositions = (feed) => {
  if (!feed?.positions?.length) return null;
  const positions = new Map();
  for (const p of feed.positions) {
    const a = normalizeAddressForVm("solana", p?.staker);
    const amount = Number(p?.amount);
    if (!a || !Number.isFinite(amount) || amount <= 0) continue;
    positions.set(a, (positions.get(a) ?? 0) + amount);
  }
  if (positions.size === 0) return null;
  return {
    chain: feed.chain ?? "solana",
    modules: [{ address: feed.programId, name: feed.name ?? "Solana staking", deployBlock: null, deployDate: null, lastBlock: feed.slot ?? null }],
    positions,
  };
};
```

`scripts/pull-solana-staking.js`:

```js
#!/usr/bin/env node
/**
 * pull-solana-staking.js --project <slug>   (or HD_PROJECT)
 * For a staking[] entry of kind "zebecStakeV1", writes
 * public/data/<slug>/solana-staking.json. Exits 0 without writing (and without
 * importing any Solana module) when the project has no such entry, e.g. TEL.
 */
import fs from "node:fs/promises";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectStakingContracts } from "./lib/projects.js";

await loadEnv();
const project = selectPipelineProject("pull-solana-staking", { ported: true });
const data = projectPaths(project);
const entries = projectStakingContracts(project, { kind: "zebecStakeV1" });
if (entries.length === 0) {
  console.log("No Solana program staking configured; nothing to do.");
  process.exit(0);
}
if (entries.length > 1) throw new Error(`${project.slug}: more than one zebecStakeV1 entry is not supported`);
const entry = entries[0];
const chain = (project.config.chains ?? []).find((c) => c.key === entry.chain);
if (!chain) throw new Error(`${project.slug}: staking chain ${entry.chain} not in chains[]`);

const { configureSolanaChain, getUsableSolanaRpcUrls, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
const { solanaBaseToken } = await import("./lib/solana/adapter.js");
const { fetchZebecStakePositions } = await import("./lib/solana/zebecStake.js");

configureSolanaChain(chain);
const urls = await getUsableSolanaRpcUrls(chain.key);
const call = (method, params) => solanaCallWithFailover(urls, method, params, { chainKey: chain.key });
const token = solanaBaseToken(chain);
const slot = await call("getSlot", [{ commitment: "finalized" }]);
const result = await fetchZebecStakePositions(call, { programId: entry.address, mint: token.address, decimals: token.decimals });

const out = {
  generatedAt: new Date().toISOString(),
  chain: chain.key,
  kind: entry.kind,
  name: entry.name ?? "Solana staking",
  slot: typeof slot === "number" ? slot : null,
  ...result,
};
await fs.writeFile(data("solana-staking.json"), JSON.stringify(out, null, 2) + "\n");
console.log(
  `${project.slug}: ${result.stakerCount} stakers, ${result.positionCount} positions, ` +
    `${Math.round(result.stakedTotal).toLocaleString()} ${project.config.ticker} staked across ${result.lockups.length} lockups.`,
);
```

`scripts/generate-holders-lite.js`: add `import { loadSolanaStakingPositions } from "./lib/solanaStaking.js";` with the other imports. Then insert this directly after line 81 (`let v3Staking = loadV3StakingPositions(…);`):

```js
  // Solana program staking (e.g. zebecStakeV1): same overlay channel, holder
  // balances untouched (staked != retail). TEL has no such file.
  if (!v3Staking) v3Staking = loadSolanaStakingPositions(await readJson(data("solana-staking.json")));
```

The local `readJson` (line 32) returns `null` on ENOENT, so TEL (no file) gets `null`. The `snapshotDate < m.deployDate` guard at line 84 is a no-op here because `deployDate` is `null`.

`src/lib/stakingSplit.ts`:

```ts
type Channel = { stakerCount: number; stakedTotal: number };
type SplitStats = { legacy?: Channel | null; v3?: Channel | null };

/** "Legacy X / v3 Y" sub-label, only when BOTH channels have stakers (TEL). */
export function stakingSplitSub(stats: SplitStats, field: "count" | "total", fmt: (n: number) => string): string | undefined {
  const { legacy, v3 } = stats;
  if (!legacy || !v3 || legacy.stakerCount <= 0 || v3.stakerCount <= 0) return undefined;
  return field === "count"
    ? `Legacy ${fmt(legacy.stakerCount)} / v3 ${fmt(v3.stakerCount)}`
    : `Legacy ${fmt(legacy.stakedTotal)} / v3 ${fmt(v3.stakedTotal)}`;
}
```

`src/components/WalletHoldingsWidget.tsx`: add `import { stakingSplitSub } from "@/lib/stakingSplit";` and replace the two `sub:` expressions at lines 780 and 785:

```tsx
      sub: stakingSplitSub(stats, "count", formatInteger),
```
```tsx
      sub: stakingSplitSub(stats, "total", formatCompactTokens),
```

- [ ] **Step 4: Unit tests + TEL regression**

Run: `npx vitest run scripts/lib/solanaStaking.test.js scripts/lib/v3Staking.test.js src/lib/stakingSplit.test.ts scripts/lib/projects.test.js scripts/lib/stakingAttribution.test.js scripts/lib/holdersView.test.js`
Expected: PASS.

```bash
node scripts/pull-solana-staking.js --project tel   # "nothing to do", exit 0
cp public/data/holders-lite.json /tmp/tel-lite-before.json
node scripts/generate-holders-lite.js               # TEL default
diff <(jq 'del(.generatedAt)' /tmp/tel-lite-before.json) <(jq 'del(.generatedAt)' public/data/holders-lite.json) && echo TEL-UNCHANGED
git checkout -- public/data/holders-lite.json public/data/holders-summary.json
```
Expected: `TEL-UNCHANGED`.

- [ ] **Step 5: Live run for ZBCN (needs SOLANA_RPC_0)**

```bash
node scripts/pull-solana-staking.js --project zebec-network
HD_PROJECT=zebec-network node scripts/generate-holders-lite.js
node -e 'const l=require("./public/data/zebec-network/holders-lite.json");const v=l.views.combined;console.log(JSON.stringify({staking:v.stakingStats,retail:v.metrics?.retail},null,1))'
```
Expected: about 4.79B ZBCN staked across 5 lockups and no vault-disagreement throw. `stakingStats.stakedTotal` ≈ 4.79e9 and `stakerCount` > 0. The retail balance must be **identical** to Task 5; that is the staked ≠ retail requirement.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/projects.js scripts/lib/projects.test.js scripts/pull-solana-staking.js scripts/lib/solanaStaking.js scripts/lib/solanaStaking.test.js scripts/lib/v3Staking.js scripts/lib/v3Staking.test.js scripts/generate-holders-lite.js src/lib/stakingSplit.ts src/lib/stakingSplit.test.ts src/components/WalletHoldingsWidget.tsx public/data/zebec-network
git commit -m "feat(zbcn): zebecStakeV1 staking pull + separate staked overlay (staked != retail)"
```

Then edit `config/projects/zebec-network.json`. Delete the `BLOCKER:` sentence in `staking[0].attribution`, and set `pipelineNotes.stakingAdapter` to `"scripts/pull-solana-staking.js (zebecStakeV1) -> public/data/zebec-network/solana-staking.json"`. Run `npx vitest run scripts/lib/zebecNetworkConfig.test.js` (PASS), then commit with the message `chore(zbcn): staking adapter live in config notes`.

---

### Task 8: Solana flows scaffolding (Token Mapper; TDD; not published)

**Files:**
- Create: `scripts/lib/solana/tokenFlows.js`, `scripts/lib/solana/tokenFlows.test.js`
- Create: `scripts/scan-solana-flows.js`

**Interfaces:**
- Consumes: parsed transactions from `getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 })` with `meta.preTokenBalances` / `meta.postTokenBalances` (`{ accountIndex, mint, owner, uiTokenAmount: { amount } }`).
- Produces:
  - `mintDeltasByOwner(tx, mint) → Map<owner, bigint>`
  - `classifyFlow(deltas, { cex: Set<string>, dex: Set<string> }) → Array<{ owner: string, raw: string, side: "in"|"out", venue: "cex"|"dex"|null }>`
  - CLI `scan-solana-flows.js --project <slug> [--limit N]` → `data/<slug>/solana-flows-sample.json` (work dir, never served)

This is scaffolding only. `exchange-flow-history.json`, `tier-outflows.json`, and `cex-balance-history.json` are **not** produced for ZBCN until the owner supplies CEX wallets. Their panels stay hidden because the feeds are missing, and QA checks that in Task 10.

- [ ] **Step 1: Write the failing tests**

`scripts/lib/solana/tokenFlows.test.js`:

```js
import { describe, expect, it } from "vitest";
import { classifyFlow, mintDeltasByOwner } from "./tokenFlows.js";

const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POOL = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const bal = (accountIndex, owner, amount, mint = MINT) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount) } });

describe("mintDeltasByOwner", () => {
  it("nets pre/post per owner for the mint only, keeping base58 case", () => {
    const tx = {
      meta: {
        preTokenBalances: [bal(1, ALICE, 1000), bal(2, POOL, 5000), bal(3, ALICE, 7, OTHER)],
        postTokenBalances: [bal(1, ALICE, 400), bal(2, POOL, 5600), bal(3, ALICE, 0, OTHER)],
      },
    };
    expect([...mintDeltasByOwner(tx, MINT).entries()]).toEqual([[ALICE, -600n], [POOL, 600n]]);
  });

  it("handles token accounts created in the tx (absent from pre)", () => {
    const tx = { meta: { preTokenBalances: [], postTokenBalances: [bal(4, ALICE, 50)] } };
    expect(mintDeltasByOwner(tx, MINT).get(ALICE)).toBe(50n);
  });

  it("handles token accounts closed in the tx (absent from post)", () => {
    const tx = { meta: { preTokenBalances: [bal(5, ALICE, 70)], postTokenBalances: [] } };
    expect(mintDeltasByOwner(tx, MINT).get(ALICE)).toBe(-70n);
  });

  it("returns an empty map for a failed tx", () => {
    expect(mintDeltasByOwner({ meta: { err: { InstructionError: [0, "x"] }, preTokenBalances: [], postTokenBalances: [] } }, MINT).size).toBe(0);
  });
});

describe("classifyFlow", () => {
  it("tags venue and side", () => {
    const d = new Map([[ALICE, -600n], [POOL, 600n]]);
    expect(classifyFlow(d, { cex: new Set(), dex: new Set([POOL]) })).toEqual([
      { owner: ALICE, raw: "600", side: "out", venue: null },
      { owner: POOL, raw: "600", side: "in", venue: "dex" },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/lib/solana/tokenFlows.test.js`
Expected: FAIL (`./tokenFlows.js` is unresolved).

- [ ] **Step 3: Implement**

`scripts/lib/solana/tokenFlows.js`:

```js
/**
 * Solana flow primitives. There is no Transfer-log range scan on Solana:
 * flows come from per-transaction token balance deltas
 * (getSignaturesForAddress on a venue token account -> getTransaction jsonParsed).
 * Owners are kept exactly as returned (base58 is case-sensitive).
 */
export function mintDeltasByOwner(tx, mint) {
  const out = new Map();
  if (!tx?.meta || tx.meta.err) return out;
  const add = (owner, v) => {
    if (owner) out.set(owner, (out.get(owner) ?? 0n) + v);
  };
  const pre = new Map();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.accountIndex, b);
  const seen = new Set();
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint !== mint) continue;
    seen.add(b.accountIndex);
    const before = BigInt(pre.get(b.accountIndex)?.uiTokenAmount?.amount ?? "0");
    add(b.owner, BigInt(b.uiTokenAmount?.amount ?? "0") - before);
  }
  for (const [idx, b] of pre) if (!seen.has(idx)) add(b.owner, -BigInt(b.uiTokenAmount?.amount ?? "0"));
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

export function classifyFlow(deltas, { cex = new Set(), dex = new Set() } = {}) {
  return [...deltas.entries()].map(([owner, v]) => ({
    owner,
    raw: (v < 0n ? -v : v).toString(),
    side: v < 0n ? "out" : "in",
    venue: cex.has(owner) ? "cex" : dex.has(owner) ? "dex" : null,
  }));
}
```

`scripts/scan-solana-flows.js`:

```js
#!/usr/bin/env node
/**
 * scan-solana-flows.js --project <slug> [--limit N]   (scaffold, dry-run)
 * Venue owners = contracts{} entries with role cex/dex. For each:
 * getTokenAccountsByOwner(mint) -> getSignaturesForAddress (newest N) ->
 * getTransaction -> classified deltas -> data/<slug>/solana-flows-sample.json.
 * Publishes nothing under public/data.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectRoleAddresses, projectWorkDir } from "./lib/projects.js";

await loadEnv();
const project = selectPipelineProject("scan-solana-flows", { ported: true });
const chain = (project.config.chains ?? []).find((c) => c.vm === "solana" || c.key === "solana");
if (!chain) {
  console.log("No Solana chain; nothing to do.");
  process.exit(0);
}
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 25;
const venues = projectRoleAddresses(project.config, { roles: ["cex", "dex"] })[chain.key] ?? []; // case-preserved for Solana
const cex = new Set(venues.filter((e) => e.role === "cex").map((e) => e.address));
const dex = new Set(venues.filter((e) => e.role === "dex").map((e) => e.address));
if (cex.size + dex.size === 0) {
  console.log(`${project.slug}: no cex/dex venue addresses in contracts{}; nothing to scan (flows stay unpublished).`);
  process.exit(0);
}

const { configureSolanaChain, getUsableSolanaRpcUrls, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
const { solanaBaseToken } = await import("./lib/solana/adapter.js");
const { mintDeltasByOwner, classifyFlow } = await import("./lib/solana/tokenFlows.js");
configureSolanaChain(chain);
const urls = await getUsableSolanaRpcUrls(chain.key);
const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: chain.key });
const mint = solanaBaseToken(chain).address;

const rows = [];
for (const owner of [...cex, ...dex]) {
  const accts = await call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
  for (const a of accts?.value ?? []) {
    const sigs = await call("getSignaturesForAddress", [a.pubkey, { limit: LIMIT, commitment: "finalized" }]);
    for (const s of sigs ?? []) {
      if (s.err) continue;
      const tx = await call("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
      for (const f of classifyFlow(mintDeltasByOwner(tx, mint), { cex, dex })) rows.push({ signature: s.signature, blockTime: s.blockTime ?? null, ...f });
    }
  }
}
const out = path.resolve(projectWorkDir(project), "solana-flows-sample.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), mint, limit: LIMIT, rows }, null, 2) + "\n");
console.log(`${project.slug}: ${rows.length} classified flow rows -> ${out}`);
```


- [ ] **Step 4: Tests + no-venue smoke**

Run: `npx vitest run scripts/lib/solana/tokenFlows.test.js && node scripts/scan-solana-flows.js --project zebec-network`
Expected: tests PASS (5). The script prints `no cex/dex venue addresses in contracts{}; nothing to scan` and exits 0.

Follow-on, which needs owner approval before any config write: resolve the token-vault owner of the Orca ZBCN/SOL pool `FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w`, add it with `role: "dex"`, run `--limit 5`, and inspect the sample.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/solana/tokenFlows.js scripts/lib/solana/tokenFlows.test.js scripts/scan-solana-flows.js
git commit -m "feat(solana): flow primitives + dry-run scan-solana-flows scaffold"
```

---

### Task 9: Daily workflow, UI wiring check, docs (Token Mapper)

**Files:**
- Create: `.github/workflows/refresh-zebec-network.yml`
- Modify: `docs/MULTI-TOKEN.md` (add a "zebec-network (Solana)" section)
- Check only: `scripts/lib/workflowChain.test.js`, `scripts/lib/deployTriggers.test.js` (or the repo's equivalents found by `rg -l "workflows" scripts/lib/*.test.js`), `npm run audit:deploys`

`refresh-tel-holders.yml` is the reference. Its schedule runs with no inputs, so `HD_PROJECT` stays `tel`. ZBCN therefore needs its own scheduled workflow. It goes in the **same** concurrency group so it never pushes at the same moment as TEL, and its cron is offset by 90 minutes.

`SOLANA_RPC_0` is read from the Actions secret. `loadEnv` (`scripts/decrypt-env.js:79`) only overwrites keys that exist inside `.env.enc`, and `.env.enc` has no `SOLANA_RPC_*`, so the secret survives. A second supported route is `printf 'SOLANA_RPC_0=…\n' | ENV_PASSPHRASE=… node scripts/set-env-keys.js`; only the owner can do that, because it needs the passphrase.

- [ ] **Step 1: Write the workflow**

```yaml
name: Refresh zebec-network holders

# ZBCN (Solana SPL). Same stage order as refresh-tel-holders.yml minus the EVM
# and CEX-only stages (no CEX wallets are configured for ZBCN). Staking is a
# separate overlay (staked != retail) pulled before the lite feed.
on:
  schedule:
    - cron: '30 1 * * *'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: holders-refresh
  cancel-in-progress: false

env:
  HD_PROJECT: zebec-network

jobs:
  refresh:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - name: Check out repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v5
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Resolve project data paths
        run: node scripts/workflow-paths.js >> "$GITHUB_ENV"

      - name: Pull Zebec staking positions
        # Non-fatal: on failure the lite feed keeps the previous staking file's
        # numbers (or none) and holders still publish.
        continue-on-error: true
        timeout-minutes: 10
        env:
          ENV_PASSPHRASE: ${{ secrets.ENV_PASSPHRASE }}
          SOLANA_RPC_0: ${{ secrets.SOLANA_RPC_0 }}
        run: node scripts/pull-solana-staking.js

      - name: Refresh holders snapshot
        timeout-minutes: 15
        env:
          ENV_PASSPHRASE: ${{ secrets.ENV_PASSPHRASE }}
          SOLANA_RPC_0: ${{ secrets.SOLANA_RPC_0 }}
        run: node scripts/pull-holders-rpc.js

      - name: Generate feeds
        run: |
          node scripts/generate-holders-lite.js
          node scripts/generate-holders-history.js
          node scripts/generate-holder-transitions.js
          node scripts/reconcile-supply.js
          node scripts/append-treasury-history.js
          node scripts/sync-classification-changelog.js

      - name: Check feeds
        run: |
          node scripts/validate-outputs.js
          node scripts/check-feed-consistency.js

      - name: Commit snapshot changes
        run: |
          git config user.email "action@github.com"
          git config user.name "github-actions[bot]"
          git add -A -- "$HD_DATA_DIR" "$HD_WORK_DIR"
          if git diff --cached --quiet; then
            echo "No changes to commit"
          else
            git commit -m "Refresh zebec-network holders snapshot"
            git checkout -- .
            git fetch origin main
            git rebase origin/main
            git push origin HEAD:main
          fi
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

If the TEL workflow's "Verify generated files" list applies (Task 5 lists the files ZBCN actually produces), copy that step in with the ZBCN file list, leaving out `cex-*.json` and `funding-wallets.json`.

- [ ] **Step 2: Workflow guard tests**

Run: `npx vitest run $(rg -l "workflows" scripts/lib/*.test.js | tr '\n' ' ') && npm run audit:deploys`
Expected: PASS. If a test enumerates workflows that may push (the deploy-trigger audit), add `refresh-zebec-network.yml` to its allowlist next to `refresh-tel-holders.yml`, in the same commit and with the same justification comment.

- [ ] **Step 3: UI wiring check (no new UI code expected)**

Run: `npm run typecheck && npx vitest run $(rg -l "TokenSwitcher|chainViews|explorerLinks|forensicsProjects" src --glob '*.test.*' | tr '\n' ' ')`
Expected: PASS. `?token=zebec-network` resolves through `PROJECT_SLUGS` (Task 2). Chain tabs come from `chains[]`, so the expected tabs are Combined and Solana. Solscan links come from `explorerLinks` for `vm: "solana"`.

- [ ] **Step 4: Docs**

In `docs/MULTI-TOKEN.md`, add a section covering:
- the slug, mint, and the fact that it is Solana-only;
- the workflow name and cron (01:30 UTC = 21:30 EDT);
- `SOLANA_RPC_0` as an Actions secret;
- staking via `pull-solana-staking.js` (`zebecStakeV1`), where the vault ATAs are role `staking` and staked ≠ retail;
- history is forward-only (`--as-of` is refused for Solana);
- flows are unpublished until CEX wallets are supplied;
- the buyback treasury is annotated.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/refresh-zebec-network.yml docs/MULTI-TOKEN.md
git commit -m "ci(zbcn): daily zebec-network refresh workflow + docs"
```

---

### Task 10: Pipeline QA gate (Pipeline QA; read-only except screenshots)

Pipeline QA runs everything below on `map/zbcn` and sends a **PASS/FAIL verdict with evidence** to the Orchestrator. FAIL items go back to Token Mapper as numbered fixes, and QA re-runs only what failed. Screenshots go in `/workspace/qa/zbcn/`.

- [ ] **Step 1: Automated gate**

```bash
npm ci
npx vitest run
npm run typecheck
npm run lint
npm run check:feeds                                   # TEL
HD_PROJECT=zebec-network npm run check:feeds
npm run build
test ! -e dist/data/zebec-network/solana-staking.json && echo "staking pipeline file not served"
git diff origin/main --stat -- public/data/*.json      # expect: no TEL feed changes
```
Expected: all pass; the last line lists no root `public/data/*.json` files.

- [ ] **Step 2: TEL isolation**

```bash
node --trace-imports scripts/pull-holders-rpc.js --project tel --help 2>&1 | rg -c "lib/solana/" || echo 0
node scripts/pull-solana-staking.js --project tel
node scripts/scan-solana-flows.js --project tel
```
Expected: `0` Solana module imports for TEL, and both scripts exit 0 with "nothing to do". If `--trace-imports` is unavailable on the Node version in use, use `NODE_DEBUG=module` and grep for `lib/solana/`.

- [ ] **Step 3: Data assertions (ZBCN)**

```bash
node -e '
const l=require("./public/data/zebec-network/holders-lite.json");
const s=require("./public/data/zebec-network/supply-reconciliation.json");
const st=require("./public/data/zebec-network/solana-staking.json");
const v=l.views.combined;
const vaults=st.lockups.map(x=>x.stakeVaultAta);
const retailAddrs=new Set((v.holders??[]).filter(h=>!h.nonRetail).map(h=>h.address));
console.log({
  chains:Object.keys(l.views),
  stakedTotal:v.stakingStats?.stakedTotal,
  stakerCount:v.stakingStats?.stakerCount,
  vaultsInRetail:vaults.filter(a=>retailAddrs.has(a)),
  treasuryInRetail:retailAddrs.has("EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW"),
  supplyGapPct:s.gapPct ?? s.summary?.gapPct,
});'
```
Expected:
- `chains` = `["combined","solana"]` (or the repo's equivalent view keys);
- `stakedTotal` ≈ 4.79e9 and `stakerCount` > 0;
- `vaultsInRetail` = `[]` and `treasuryInRetail` = `false`;
- the supply gap is within `SNAPSHOT_SUPPLY_TOLERANCE` (1%).

Adjust field names to the actual feed shape and record the real names in the verdict.

- [ ] **Step 4: Browser checklist** (`npm run dev`, then `http://localhost:5173/?token=zebec-network`, at 1440×900 and 390×844)

1. The token switcher lists TEL and ZBCN. Switching changes the ticker, logo, and every number, with no TEL leftovers.
2. The main dashboard fits in one viewport at 1440×900, with no clipping at 390×844.
3. Only the Combined and Solana chain tabs show, with no EVM tabs.
4. Retail metrics exclude the stake-vault ATAs and the buyback treasury. The treasury appears with its annotation.
5. The Staked tile shows about 4.79B and the staker count, with **no** "Legacy 0 / v3 …" sub-label. "% of Retail ZBCN Staked" renders.
6. The history chart starts at the first ZBCN snapshot date (forward-only), with no back-filled points.
7. Address links open Solscan with case-exact base58. Spot-check 3 links, including one vault ATA.
8. Flow, tier-outflow, and CEX panels are hidden or show the empty state, not errors or TEL data.
9. The forensics view shows the empty state for ZBCN.
10. The live-data path works: `curl -s "localhost:8888/.netlify/functions/live-data?project=zebec-network&file=holders-lite.json" | jq .generatedAt` under `netlify dev` returns the ZBCN feed. Use the parameter names from `netlify/functions/live-data.mjs`.
11. TEL with no `?token` is unchanged; compare against a screenshot of `origin/main`.

- [ ] **Step 5: Verdict**

Send the Orchestrator a single message with: PASS/FAIL per step, the command output for anything that is not obvious, screenshot paths, and numbered fix requests for any FAIL.

---

### Task 11: Batched PR (Orchestrator decides; Token Mapper executes)

Gate: QA **PASS** from Task 10 **and** an explicit "go" from the Orchestrator after it reports to the owner. Nothing in this task runs before that.

- [ ] **Step 1:** `git fetch origin && git rebase origin/main`, then repeat Task 10 Step 1. All must pass.
- [ ] **Step 2:** `git log --oneline origin/main..HEAD` should show only `map/zbcn` commits: plan, config, data dirs, snapshot, adapter, staking, flows scaffold, workflow/docs. Then run `git diff origin/main --stat | rg -i "\.env$|secret|key"`; it must return nothing.
- [ ] **Step 3:** `git push -u origin map/zbcn`, then open the PR titled `Map ZBCN (zebec-network, Solana)`. The body covers the phases done, QA verdict, screenshots, known gaps (flows unpublished, forward-only history), and owner actions.
- [ ] **Step 4 (owner):** add the repo Actions secret `SOLANA_RPC_0` (Settings → Secrets and variables → Actions). The Orchestrator asks; agents never handle the value outside the in-chat form and the gitignored local `.env`.
- [ ] **Step 5:** After the PR is merged with the owner's approval, run `refresh-zebec-network.yml` once via `workflow_dispatch`. Watch it until it is green, and confirm that its commit lands only in `public/data/zebec-network/**` and `data/zebec-network/**`.

---

### Task 12: Go-live report (Orchestrator → owner)

- [ ] **Step 1:** Load the production URL `?token=zebec-network` and repeat checklist items 1, 4, 5, and 7 from Task 10 on the live site.
- [ ] **Step 2:** Send the owner a report containing:
  - the live link;
  - holders, retail, and staked figures (≈4.79B / staker count);
  - top-holder classification notes, with the buyback treasury annotated;
  - the first history date;
  - the workflow schedule (daily 21:30 EDT);
  - what is intentionally not shown yet (exchange flows, until CEX wallets are supplied; back-filled history);
  - optional next steps: the Orca pool as a `dex` venue, CEX wallets, and a ZBCN wireframe polish pass.

---

## Self-Review

**Spec coverage:**

| Brief item | Task |
|---|---|
| Phase 0 / wireframe / research done | Status table |
| Phase 2 config (draft) committed + validated | 2 |
| Data layout (`public/data/zebec-network`, `data/zebec-network`) | 3 |
| Holders snapshot (needs `SOLANA_RPC_0`) | 4 |
| History from snapshots (forward-only, `--as-of` refused) | 5 |
| `zebecStakeV1` adapter | 6 |
| Staked ≠ retail, separate Staked tile | 7 |
| Solana flows scaffolding (unpublished) | 8 |
| UI / live-data `PROJECT_SLUGS` | 2 (slug), 9 (UI check) |
| Daily refresh | 9 |
| Pipeline QA | 10 |
| PR / batch push (gated) | 11 |
| Go-live report | 12 |
| No invented CEX wallets; treasury annotated | 2, 8, 10 |

**Name consistency:**
- `fetchZebecStakePositions`, `stakeVaultPda`, `associatedTokenAddress`, and the `*_DISCRIMINATOR` constants are defined in Task 6 and used in Task 7.
- `loadSolanaStakingPositions` returns the same `{chain, modules, positions}` shape as `loadV3StakingPositions`.
- `stakingSplitSub(stats, "count"|"total", fmt)` is used at both widget sites.
- `mintDeltasByOwner` / `classifyFlow` are used only by `scan-solana-flows.js`.
- The staking file is `solana-staking.json` throughout.

**Verified facts (computed with the repo's own `pda.js`/`address.js` while writing this plan):**
- `stakeVaultPda("6ucsPucz…")` = `HJqK7re4…`, ATA = `3DC8cdCN…`
- `stakeVaultPda("BkdevFCT…")` = `5Fe1JVUk…`, ATA = `8bbygT4w…`
- Discriminators in base58: UserStakeData `JhUdhXPfFGe`, Lockup `CQrdqq8mRC`.

Checked against repo code:
- `projectStakingContracts` lowercases addresses, which is fixed in Task 7.
- `projectRoleAddresses` returns `{ [chainKey]: [{name,address,role}] }`, and Task 8 uses that shape.
- `generate-holders-lite.js`'s `readJson` returns `null` on ENOENT.

**Placeholder scan:** none. Field-name adjustments are called out where a feed's exact JSON keys can only be confirmed after the first live run (Task 10 Step 3).
