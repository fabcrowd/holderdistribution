# Forensics section (password-gated)

> Multi-token: every project gets the same gated panels and gate keys. The
> request carries `project` (default TEL), and other projects' files live under
> `data/<slug>/forensics/`. The password gate is temporary; a paywall will
> replace it. See docs/MULTI-TOKEN.md "Gated forensics". The rest of this page
> describes TEL, whose paths are unchanged.

The Supply tab has gated content: the Reconciliation ledger, History, wallet
drill-downs and **Wallet flows**. One password (or a Supabase admin session)
unlocks all of it. The unlock is shared across Supply sub-tabs and remembered in
`localStorage` on that browser.

## How it is protected

| Piece | Where | Public? |
|---|---|---|
| UI code (`WalletFlowsPanel`, `TelDispositionLedger`, …) | client bundle | yes, **no data inside** |
| Gated data: wallet write-ups, treasury ledger, wallet-flows report | bundled into `netlify/functions/forensics-gate.cjs` only | no |
| `data/forensics/wallet-flows.json` (+ `.registry.json`) | repo root `data/`, not `public/` | no (not in `dist/`) |

- The browser POSTs `{address, password}` to `/.netlify/functions/forensics-gate`.
  Wrong or missing password → `401`, no data. Keys: `wallet-flows`,
  `tel-disposition-ledger`, `association-stablecoin-flows`, or a wallet address.
- All gate responses are `Cache-Control: no-store`.
- **CORS / origin:** only `https://holderdistribution.com`, `https://www.holderdistribution.com`,
  the site's own Netlify URLs (`URL`, `DEPLOY_URL`, `DEPLOY_PRIME_URL`), extra origins in
  `FORENSICS_ALLOWED_ORIGINS` (comma-separated), and localhost under `netlify dev`. A
  browser request from any other origin gets `403`. (Requests with no `Origin`, e.g. curl,
  are allowed but still need the password.)
- **Rate limits (per IP, per function instance):** 20 requests/minute, and 10 failed
  passwords per 15 minutes → `429` until the window resets.
- **Comparisons** are constant-time (`crypto.timingSafeEqual` on digests).
- Tests: `netlify/functions-src/forensics-gate.test.ts` (401 without/wrong password, data
  with password, origin rejection, lockout, salted hash), and
  `scripts/lib/walletFlows.test.js` (report not in `public/`, only the DEV loader imports it).
- Verify after any build: `rg -l "Settlement hub|0x17fcc1f3" dist/assets` must print nothing.
  (Holder addresses legitimately appear in the public holder lists under `dist/data/`;
  the labels, flows and verdicts must not.)

## Passwords: what is accepted, and rotating to a salted hash

Accepted, any match unlocks:

1. `FORENSICS_PASSWORD_HASH` (Netlify env) — salted PBKDF2-SHA256,
   `pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>`.
2. `FORENSICS_PASSWORD` (Netlify env) — plaintext.
3. The legacy unsalted SHA-256 in `src/lib/forensicsPasswordHash.ts` (the current
   password). Kept for backward compatibility.

To move to a salted hash **without changing the password**:

```bash
printf '%s' 'THE-CURRENT-PASSWORD' | node scripts/hash-forensics-password.js
# → pbkdf2-sha256$600000$<salt>$<hash>
```

1. Netlify → Site configuration → Environment variables → add
   `FORENSICS_PASSWORD_HASH` = that output (scope: Functions).
2. Add `FORENSICS_DISABLE_LEGACY_HASH` = `1`.
3. Deploy (env vars reach functions only after a deploy). Check the password still unlocks.
4. Optionally delete the constant from `src/lib/forensicsPasswordHash.ts` in a later
   change. It is in git history either way, so a real rotation means a new password:
   hash the new one, set it, and tell the people who use it.

## Wallet flows report

Contents (all behind the gate):

- **Supply distribution by entity class:** TEL Treasury, Association Safes and
  operational wallets, Telcoin Holdings, escrow and custody, staking contract, CEX
  (including deposit relays), DEX pools and market makers, tracked sell bots and large
  sellers, other labelled, retail. Starts from `public/data/supply-reconciliation.json`
  and moves tracked wallets the reconciliation leaves inside "retail" into their class.
  The total doesn't change.
- **Telcoin-linked wallets** (44): label, group, label source, confidence, address with
  explorer links per chain, balance (legacy + v3), TEL sent to sell venues in 72h / 30d / 90d,
  every outflow type, sample transactions, verdict.
- **Bot cluster** (10 Polygon wallets): holdings, DEX sales per window, addresses.
- **Funding links** (from manual inbound tracing, carried over between runs).
- **Recent large sellers** (72h).

### Regenerating

```bash
RPC_PREFER_PUBLIC=1 node scripts/generate-wallet-flows.js            # writes data/forensics/wallet-flows.json
node scripts/generate-wallet-flows.js --dry-run --skip-sellers       # quick check, writes nothing
```

- Keyless public RPCs; about 15 to 20 minutes for all three chains. The 90-day
  known-wallet numbers reproduce the manual 2026-10-19 analysis exactly. Large-seller
  discovery is an automated approximation of it: it flags DEX swaps by swap events in
  receipts and follows one hop through deposit addresses. Expect small differences.
- **Non-fatal.** On any error it leaves the previous file untouched and exits 0
  (`--strict` exits 1).
- Edit labels, sources, confidence, the bot cluster and watched sellers in
  `data/forensics/wallet-flows.registry.json`, not in the generated report.
- **Schedule:** `.github/workflows/refresh-wallet-flows.yml` runs **weekly** (Mon) and on
  demand. It is not in the daily job because one run costs about 15 to 20 Actions minutes,
  and daily would push the monthly total close to the 2,000 free minutes.
- **Reaching the live site:** with `LIVE_DATA_GITHUB_TOKEN` set in Netlify, the gate
  fetches the latest committed report from GitHub (1 h in-memory cache, falls back to
  the bundled copy). The `X-Wallet-Flows-Source: github|bundled` response header shows
  which one was served. Without the token, the bundled copy from the last deploy is served.

### Solana projects (e.g. ZBCN)

Every project with `gated.forensics: true` needs a registry, and `npm run check:feeds` fails without one.

```bash
node scripts/init-forensics-registry.js --project <slug> [--dry-run] [--force]   # registry from config contracts
node scripts/generate-wallet-flows-solana.js --project <slug> --dry-run          # signature counts and Helius credit estimate, writes nothing
node scripts/generate-wallet-flows-solana.js --project <slug>                    # writes the report and the scan state
```

- **Registry:** `init-forensics-registry.js` takes the `treasury` and `holdings` contracts from the project's chain config. Confidence is parsed from each contract's `$comment` ("high", "medium" or "low"; none means low). It refuses to overwrite without `--force`. Review the labels and confidence afterwards, because the file is hand-editable.
- **Report:** the generator scans each registry wallet's token account for the mint over 90 days, classifies first-hop outflows by owner (CEX, DEX, staking, internal or unlabelled) and writes `data/<slug>/forensics/wallet-flows.json` in the same shape the panel already reads. Large-seller and bot-cluster discovery don't run on Solana.
- **State:** `wallet-flows-state.json` (next to the report) keeps the scan cursors and the last 90 days of events, so later runs only fetch new signatures. It is committed by the workflow.
- **Cost:** about 1 Helius credit per call. The first ZBCN dry run found 109 signatures (about 119 credits) in 90 days. A run is capped by `--max-tx` / `WALLET_FLOWS_MAX_TX` (2,500), `WALLET_FLOWS_PER_WALLET_MAX` (400) and `WALLET_FLOWS_MAX_MS` (20 min). A dry estimate above `config/budgets.json` `perRunWarn.heliusCredits` stops the run unless `--force`.
- **Sales tracing (Solana):** when a registry wallet sends the token to a DEX, the scan reads every token balance change of the same transaction (no program parsing) and records the sale: what came back (USDC/USDT, or SOL from native lamports plus wSOL), then follows the proceeds' token account for onward sends. Outflows to unlabelled wallets are also followed one more hop (`WALLET_FLOWS_TRACE_DEPTH`, default 1, max 2). Two optional report sections hold the result and are hidden in the panel when empty: `salesJournal` (last 50 sales, ZBCN sold, proceeds, effective price, onward status) and `unlabelledTrace` (top 25 unlabelled destinations with where the funds went next). Stablecoins count 1 USD; SOL is valued at report time with the CoinGecko `solana` price (`valuedAtReportTime`); other mints stay unpriced. Native SOL proceeds are not followed onward (shown as "Not tracked"). A destination with more than 100 new signatures is marked "busy" (probably an exchange or a program): label it in the registry or CEX list instead of tracing it.
- **Sales tracing caps:** `WALLET_FLOWS_FOLLOW_MAX_CALLS` (300 calls per run, counted exactly), `WALLET_FLOWS_FOLLOW_MAX_TASKS` (40), `WALLET_FLOWS_FOLLOW_MAX_TX` (30 per task), `WALLET_FLOWS_SALE_DEPTH` (2), `WALLET_FLOWS_TRACE_MIN_TOKENS` (100,000 tokens), `WALLET_FLOWS_FOLLOW_MAX_MS` (10 min, separate from the scan budget). State lives in `wallet-flows-state.json` (`sales`, `follow.tasks`, `follow.hops`; additive, older state files load as they are). Heuristic caveats: aggregator and multi-hop routes can credit a different owner than the wallet, and unrelated tokens received in the same transaction count as proceeds.
- **Workflow:** `refresh-wallet-flows.yml` runs the Solana generator after the EVM one. Dispatch it with `project=zebec-network`; the schedule stays TEL-only.

## Backfill via SQD Portal

`scripts/generate-wallet-flows.js` can take its large-log scan from the SQD Portal instead of
RPC `eth_getLogs`. The default stays `rpc`, and the weekly workflow (`refresh-wallet-flows.yml`)
is unchanged.

**Flags**

- `--source rpc|portal`: log source. Default `rpc`. The flag wins over `HD_BACKFILL_SOURCE`. Any
  other value exits 1.
- `--as-of <YYYY-MM-DD | ISO timestamp with Z or offset>`: anchors the 72h / 30d / 90d windows to
  that moment. Requires `--out`. A future date is rejected.
- `--out <path>`: writes the report there (repo-relative). It must not resolve under `public/`,
  and with `--as-of` it must not be the live `data/forensics/wallet-flows.json`.

```bash
node scripts/generate-wallet-flows.js --source portal --as-of 2026-09-01 --out data/forensics/backfill-2026-09-01.json
```

**Environment**

| Variable | Default | Purpose |
|---|---|---|
| `HD_BACKFILL_SOURCE` | `rpc` | Same as `--source`; the flag wins. |
| `SQD_PORTAL_API_KEY` | unset | Optional `x-api-key` header. Read from env only; never printed or committed. |
| `PORTAL_MAX_REQUESTS` | `200` | Request cap per run. A runaway loop fails loudly. |
| `PORTAL_CONFIRMATIONS_ETHEREUM` / `_POLYGON` / `_BASE` | `64` / `128` / `64` | Portal scans end at head minus this many blocks, to stay clear of reorgs. |
| `PORTAL_COMPLETENESS_BLOCKS` / `PORTAL_COMPLETENESS_WINDOWS` | `5000` / `6` | Size and count of the sampled windows the completeness gate compares. |

**What Portal serves, and what stays on RPC**

- Only the 72h large-seller discovery scan goes to Portal. It filters on the public token
  contracts and `Transfer` topic0 only, so no wallet address is sent.
- The registry outflow scan (which filters on sender addresses: known wallets and the bot
  cluster) always stays on RPC, even with `--source portal`. Sender lists are never sent to Portal.
- Block timestamps, balances, receipts, prices and window anchors still use RPC.

**Completeness gate**

Portal can end a stream early without an error. The Base live test returned 105 logs where RPC
had 204. Before a Portal-sourced scan is used, the script compares `transactionHash:logIndex`
key sets with RPC `eth_getLogs` on sampled windows (the start and end of the scanned range).
Any missing or extra key exits 1 before anything is written. The message names the chain and
counts only.

Limitation: the gate samples. It covers six evenly spaced windows of 5,000 blocks (capped at the chain log span), not the whole range, so a gap
outside them can pass. Raise `PORTAL_COMPLETENESS_BLOCKS` or `PORTAL_COMPLETENESS_WINDOWS` to
widen the sample, at the cost of more RPC calls.

**Output rules**

- A Portal run adds `source: portal` to the report notes, so provenance is visible.
- Output is gated forensics data. It goes under `data/` only, never under `public/`. The gate
  function serves only the live `wallet-flows.json`, so a backfill file is not served until someone
  promotes it.
- An `--as-of` report has `balances` and USD values set to `null`. Current balances and prices
  cannot be recovered for a past date without archive reads and a historical price source. The
  report notes say so, and `asOf` is recorded at the top level. Supply distribution still uses the
  current supply reconciliation, and funding links are carried over from the `--out` file only if
  it already exists.
