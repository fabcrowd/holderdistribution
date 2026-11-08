# Holder Distribution — Claude Handoff

## Git rule (owner, standing)

Never create a branch, commit or push unless the owner explicitly says so. Edit locally, show the diff, stop. Approval of a plan, a placement or "do it" is not approval to commit.

**README rule (owner, standing):** every PR that is pushed must update `README.md` in the same PR: the project list, the layout map, and "Recent work" with the merged PR numbers and what changed. A PR without that update is not ready to push.

---

## What this repo is

A single-page React app that shows on-chain analytics for every registered token (`config/projects.json`): holder distribution, supply breakdown, exchange flows, and historical growth trends. The site is the product; each token is a page at `/<slug>`, and TEL is one of them, not the product. It lives at **holderdistribution.com** and is deployed on Netlify.

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

---

## Deployment

**Deploys are manual-only.** Git pushes do NOT trigger Netlify builds.

To deploy:
1. Push code to `main` on GitHub
2. Go to the Netlify dashboard → trigger a manual deploy

Why: data refresh commits run frequently and shouldn't trigger full rebuilds.

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

- **Multi-token onboarding** — every check and feed is registry-driven (`config/projects.json` + `config/projects/<slug>.json`). No TEL-shaped logic in shared code. New tokens follow `.claude/skills/onboard-project/SKILL.md` and `docs/MULTI-TOKEN.md`.
- **Prove the 2026-11-07 fixes (#165–#171) on the scheduled 06:00 UTC runs** — `check:feeds` and `check-go-live --all` green, `holders-summary.json` asOf restored, `cex-flows` rebuilt with the KuCoin relays, zebec retail agrees across feeds. Unproven until a scheduled run passes.
- **Design system rollout** — tokens are in `tailwind.config.ts` and `design-system/tokens.css`. Components should progressively adopt the semantic tokens (`brand`, `positive`, `negative`, `ha-accent`, etc.) instead of raw Tailwind color classes.
- **Forensics Gate** — premium content gate in `netlify/functions/forensics-gate.cjs`. Gated via `ForensicsGate.tsx` + `SubscriptionGate.tsx` components.


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
- `.github/workflows/`: nightly refresh (`refresh-holders.yml`), backfills, replays.
- `src/lib/`: pure helpers (charts: `chartAxes`, `chartZoom`; supply: `supplyBreakdown`, `chainViews`; staking: `staking*`; `projects.ts` registry reader).
- `src/components/`: widgets; `chart/`, `terminal/`, `tierflow/`, `ui/` subfolders. `src/pages/`: routes.
- `netlify/functions/`: `live-data.mjs` (serves latest feeds from GitHub), `forensics-gate.cjs`. `netlify.toml`: manual-deploy rules.
- Local-only, uncommitted: `tasks/`, `.cursor/`, and `.claude/` except `.claude/skills/`; `scripts/CLAUDE.md` is tracked. `design-system/`, `docs/`: specs.
- Harness: `.claude/HANDOFF.md` (session facts, decisions, progress); `npm run receipt -- --objective "..." [--verify]` writes `tasks/receipt.md` (what changed, what passed); `.claude/agents/verifier.md` (adversarial check before a slice is marked done); `tasks/harness-audit.md` (which gates caught which lessons). Git commit, push, branch, merge and reset are set to `ask` in `.claude/settings.local.json`.
