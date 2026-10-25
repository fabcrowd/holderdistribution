# Wrapped / bridged tokens: implementation plan (executed)

Spec: `docs/superpowers/specs/2026-10-25-wrapped-bridged-tokens-design.md` (CoinGecko model: one total, per-chain parts).

- [x] 1. Config: `chains[].bridge` (`native` | `lock-mint` | `burn-mint`), one `origin`, `contracts{}.role`; validation errors and warnings.
- [x] 2. `supply.js`: `selectSupplyMethod` (TEL → `tel-generations`, unchanged) and `computeBridgeNettedSupply` (total = origin + native/burn-mint; lock-mint adds 0; origin locks are non-circulating; backing residual warns above 1%; target check only when set).
- [x] 3. `pull-holders-rpc.js`: lock set = `bridge-lock`/`escrow` labels plus origin bridge/escrow contracts; role addresses are non-retail.
- [x] 4. `reconcileSupply.js`: only lock-mint chains are mirrors; other chains count as their own supply.
- [x] 5. Non-retail: `projectNonRetailPaths().extraAddresses` for generic projects (TEL unchanged).
- [x] 6. Discovery: `suggestedBridge` + `bridgeNeedsConfirmation`; never writes config.
- [x] 7. Tests: `bridgeNetting.test.js`, `solanaFeeds.test.js` (reconcile), TEL regression.
