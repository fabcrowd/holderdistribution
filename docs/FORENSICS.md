# Forensics section (password-gated)

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
