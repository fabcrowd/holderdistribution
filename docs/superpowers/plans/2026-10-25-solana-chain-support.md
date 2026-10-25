# Solana chain support: implementation plan (executed)

Spec: `docs/superpowers/specs/2026-10-25-solana-chain-support-design.md` (Approach A: adapters keyed by `chains[].vm`).

- [x] 1. `scripts/lib/address.js`: `normalizeAnyAddress` (hex lowercased, base58 kept), base58 32-byte check. Tests: `address.test.js`.
- [x] 2. `scripts/lib/chainAdapters.js`: registry with lazy `import("./solana/adapter.js")` and `loadedAdapterVms()`. Test: TEL never loads Solana.
- [x] 3. `scripts/lib/solana/rpc.js`: public RPC first, then `SOLANA_RPC_0..9`, `getHealth` probe, failover with a `SOLANA_RPC_*` hint.
- [x] 4. `pda.js` + `metadata.js`: Metaplex PDA, Token-2022 extension → Metaplex → config symbol; mint decimals/program checked against config.
- [x] 5. `splScanner.js`: `getProgramAccounts` (SPL dataSize 165 + memcmp; Token-2022 memcmp), per-owner aggregation, refuses a gap >1% vs supply.
- [x] 6. `adapter.js`: `health`, `tokenMeta`, `scanHolders`, `scanChain` returning EVM-shaped results.
- [x] 7. `projects.js`: `validateProjectConfig` (fails before any network call), Solana chain derivation, `projectChains` EVM-only by default, `projectChainsAllVms`, `projectRoleAddresses`.
- [x] 8. `pull-holders-rpc.js`: dispatches Solana chains to the adapter; Solana checkpoint entries carry `{vm, lastSlot, scannedAt}`; `--as-of` refused.
- [x] 9. Normalization sweep (non-retail sets, holdersView, history, transitions, reconcile, stakingAttribution).
- [x] 10. UI: `src/lib/explorerLinks.ts` (Solscan defaults, `explorerTemplates`), chain meta, methodology, wallet-flow links, "(stale)" chain status.
- [x] 11. Discovery: Solana row (CoinGecko `platforms.solana` plus RPC probe), base58 `--address`.
- [x] 12. Docs (MULTI-TOKEN.md, map-new-token skill) and the smoke script `scripts/solana-smoke.js`.

Deferred (spec non-goals): Solana staking, flows, forensics, history back-fill, `--as-of`, other non-EVM chains.
