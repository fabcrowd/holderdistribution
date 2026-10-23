/**
 * The public/data feeds the deployed site actually serves to browsers. Every
 * other public/data file is pipeline state (per-address balance maps,
 * checkpoints, 30 MB holder lists) that only GitHub Actions reads from the repo,
 * so scripts/prune-dist-data.js removes it from dist/ after `vite build`.
 *
 * scripts/lib/browserDataFiles.test.js proves this list covers every
 * resolveDataUrl("…") call in src/, so a new feed can't be pruned by accident.
 */
export const BROWSER_DATA_FILES = new Set([
  "holders-lite.json",
  "holders-summary.json",
  "holders-history.json",
  "chain-status.json",
  "holder-transitions.json",
  "supply-reconciliation.json",
  "treasury-history.json",
  "tier-outflows.json",
  "exchange-flow-history.json",
  "cex-balance-history.json",
  "classification-changelog.json",
]);
