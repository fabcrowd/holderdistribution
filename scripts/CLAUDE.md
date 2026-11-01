# Data pipeline (scripts/)

### TEL v3 (two tokens, one 100B supply)

Telcoin upgraded TEL: legacy TEL (2 decimals, per-chain address) is swapped 1:1 for TEL v3 (18 decimals, one
address on every chain) through `TokenMigration`, which locks the legacy TEL and mints the v3. The pipeline
therefore tracks **both** tokens (`config/chains.json` `tokens.legacy` / `tokens.v3`, with `deployBlock`):

- A wallet's balance (`*_balance` in `tel-holders.json`) = legacy + v3, each normalised with its own decimals
  (`scripts/lib/telTokens.js`). The v3 share is also published as `ethereum_v3` / `polygon_v3` / `base_v3`
  (only when non-zero), so pre-v3 snapshots stay valid unchanged.
- Legacy TEL that the upgrade contracts received **in the same tx that minted v3** is "retired" (netted out of
  the contract's wallet); legacy sent there with no swap stays counted once. `TokenMigration` and
  `MigrationVault` are labelled `escrow` in `config/exclusions.json`.
- v3 is checkpointed separately (`holders-checkpoint.json` → `chains.<chain>.v3`) and scanned from its deploy
  block. `--as-of` rebuilds are legacy-only and refuse dates on/after the v3 deploy.
- Supply identity (`scripts/lib/supply.js`): total = legacy supply on Ethereum (100B); `totals.crossCheckTotal`
  (Σ chains of legacy+v3 − Ethereum bridge locks) must land on it. `node scripts/verify-tel-supply.js` re-derives
  the whole proof from public RPCs. Derivation and numbers: `docs/TEL-CONTRACTS.md`, "Supply accounting".

- Balances are replayed from zero, so each chain's legacy scan must start at the token's **deploy block**
  (`fromBlock`; Polygon 11,264,036 — it used to be 21.5M, which dropped ~298M TEL of early holders). The
  checkpoint records the `fromBlock` it was built from and is rebuilt (legacy part only) if config changes it.
  The first run after such a change is a full Polygon rescan.
