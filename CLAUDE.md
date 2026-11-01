# Holder Distribution — Claude Handoff

## Git rule (owner, standing)

Never create a branch, commit or push unless the owner explicitly says so. Edit locally, show the diff, stop. Approval of a plan, a placement or "do it" is not approval to commit.

---

## What this repo is

A single-page React app that shows on-chain analytics for the TEL token: holder distribution, supply breakdown, exchange flows, and historical growth trends. It lives at **holderdistribution.com** and is deployed on Netlify.

The site was originally extracted from a larger Telcoin Hub multi-page app. It is now its own standalone product under the **Holder Distribution** brand — rebranded from "TelcoinHub" to "Holder Distribution".

---

## Design system

Full spec lives in `design-system/` and `BRAND.md` inside it.

**Brand:** Holder Distribution — on-chain holder tracking tool. Tone: precise, current, data-first.

**Key tokens** (defined in `tailwind.config.ts` + `src/index.css`):
- `brand` — dark teal, primary identity color
- `accent` (gold) — premium/featured moments only, never everyday actions
- `positive` / `negative` — green/red for actual holder inflows/outflows only
- `warning` — caution, separate from accent
- `ha-accent` — alias for gold accent in Tailwind

**Fonts:** Inter (UI text) + IBM Plex Mono (chain-native values: amounts, addresses, hashes)

**Logos:** Three lockups in `src/assets/` and `design-system/logos/`:
- `holder-analytics-icon.svg` — mark only (favicon, avatars)
- `holder-analytics-stacked.svg` — icon above wordmark (portrait/square placements)
- `holder-analytics-horizontal.svg` — icon beside wordmark (nav bar)

---

## Deployment

**Deploys are manual-only.** Git pushes do NOT trigger Netlify builds.

To deploy:
1. Push code to `main` on GitHub
2. Go to the Netlify dashboard → trigger a manual deploy

Why: data refresh commits run frequently and shouldn't trigger full rebuilds.

**Build command:** `npm run build`
**Publish dir:** `dist`
**Functions dir:** `netlify/functions`

The `prebuild` script runs `generate-sitemap.ts` and `bundle-forensics-gate.js` automatically before `vite build`.

---

## Data pipeline (scripts/)

Node.js scripts that pull on-chain data and update JSON files in `data/`. TEL v3 accounting rules: `scripts/CLAUDE.md`.

**Important:** data-refresh commits are tagged `[skip netlify]` or rely on the `ignore = "exit 0"` rule — they do not trigger deploys.

---

## Environment variables

Required for Supabase and RPC access. Use `scripts/loadEnv.js` for local dev.
Secrets are encrypted via `scripts/encrypt-env.js` / `decrypt-env.js`.

---

## Current goals / active work

- **Rebrand status (2026-10-18):** the UI, theme tokens, logo, favicons, OG image, meta tags and canonical URLs are now Holder Distribution / holderdistribution.com. `src/index.css` maps the shadcn variables to the Holder Distribution palette; `--ha-*` tokens are defined there. See `README.md` and `docs/DEPLOYMENT.md` for run/deploy/security notes.

- **Rebranding** from "TelcoinHub" → "Holder Distribution" is complete across the UI, copy, meta tags and design-system docs. Remaining "Holder Analytics" text is limited to asset file names and the `HolderAnalytics` design-system bundle namespace.
- **Design system rollout** — tokens are in `tailwind.config.ts` and `design-system/tokens.css`. Components should progressively adopt the semantic tokens (`brand`, `positive`, `negative`, `ha-accent`, etc.) instead of raw Tailwind color classes.
- **Forensics Gate** — premium content gate in `netlify/functions/forensics-gate.cjs`. Gated via `ForensicsGate.tsx` + `SubscriptionGate.tsx` components.

---

## Repo

GitHub: `https://github.com/fabcrowd/holderdistribution`
Branch: `main`
Live site: `https://holderdistribution.com`


---

## Token discipline

- Search (Glob/Grep) before reading; read line ranges, not whole large files.
- Logs, keys and long outputs go in a gitignored file (e.g. `.env`, scratchpad) and are referenced by path, never pasted into chat.

---

## Where things live

- `config/projects.json` + `config/projects/<slug>.json`: token registry and per-token config (source of truth). `config/exclusions.json`, `cex-wallets.json`, `chains.json`: shared classification.
- `scripts/*.js`: feed generators and pipeline CLIs. `scripts/lib/`: shared logic with sibling `*.test.js` (rpc, replay, supply, circulating, holders).
- `scripts/check-feed-consistency.js` (`npm run check:feeds`), `pipeline-health.js`: feed gates.
- `public/data/` (TEL legacy root) and `public/data/<slug>/`: generated feeds. Never hand-edit; regenerate by script. `data/`: caches and checkpoints.
- `.github/workflows/`: nightly refresh (`refresh-tel-holders.yml`), backfills, replays.
- `src/lib/`: pure helpers (charts: `chartAxes`, `chartZoom`; supply: `supplyBreakdown`, `chainViews`; staking: `staking*`; `projects.ts` registry reader).
- `src/components/`: widgets; `chart/`, `terminal/`, `tierflow/`, `ui/` subfolders. `src/pages/`: routes.
- `netlify/functions/`: `live-data.mjs` (serves latest feeds from GitHub), `forensics-gate.cjs`. `netlify.toml`: manual-deploy rules.
- `tasks/`, `.claude/`, `scripts/CLAUDE.md`: local-only, uncommitted. `design-system/`, `docs/`: specs.
- Harness: `.claude/HANDOFF.md` (session facts, decisions, progress); `npm run receipt -- --objective "..." [--verify]` writes `tasks/receipt.md` (what changed, what passed); `.claude/agents/verifier.md` (adversarial check before a slice is marked done); `tasks/harness-audit.md` (which gates caught which lessons). Git commit, push, branch, merge and reset are set to `ask` in `.claude/settings.local.json`.
