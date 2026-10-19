# Holder Distribution

On-chain holder analytics for the **TEL** token — holder distribution and tiers, supply
breakdown, exchange flows and historical growth — published at
[holderdistribution.com](https://holderdistribution.com) under the **Holder Analytics** brand.

A single-page React app (`/` and `/holders`) that reads static JSON feeds produced by a
scheduled Node data pipeline. Independent, community-run; not affiliated with Telcoin.

## Stack

React 18 · TypeScript · Vite 5 · Tailwind CSS 3 · Radix UI · Recharts · TanStack Query ·
Supabase (auth only) · Netlify (static hosting + one function).

## Quick start

```bash
nvm use            # Node 22 (.nvmrc)
npm ci
npm run dev        # http://localhost:8080
```

No secrets are needed to run the UI: it reads the committed JSON in `public/data/` and uses
the public Supabase anon key baked in as a default. See [`.env.example`](.env.example).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (regenerates the sitemap first) |
| `npm run lint` | ESLint (0 errors expected; 4 shadcn fast-refresh warnings are known) |
| `npm run typecheck` | `tsc` for app + node configs |
| `npm test` | Vitest — UI/config tests in `src/`, pipeline logic tests in `scripts/` |
| `npm run build` | Sitemap + forensics-gate bundle, then `vite build` → `dist/` |
| `npm run preview` | Serve `dist/` locally (port 4173) |
| `npm run check:feeds` / `pipeline:health` | Validate / report on the data feeds |

## Layout

```
src/pages/Holders.tsx      the page (Holders · Distribution · Supply tabs)
src/components/            widgets + ui/ (shadcn primitives)
src/hooks/                 TanStack Query data hooks
src/lib/                   pure helpers
src/index.css, tailwind.config.ts   design tokens (Holder Analytics palette)
public/data/               JSON feeds served as /data/*
scripts/                   data pipeline (RPC / Etherscan / Dune) + tests
netlify/functions-src/     forensics gate (bundled to netlify/functions by prebuild)
design-system/             brand spec, tokens, logos
.github/workflows/         ci.yml + scheduled data-pipeline workflows
docs/DEPLOYMENT.md         deploy + production-readiness runbook
docs/FORENSICS.md          password-gated forensics (Wallet flows), gate hardening, password rotation
docs/TEL-CONTRACTS.md      TEL contract registry (legacy vs. v3) + supply accounting (legacy + v3 = 100B)
CLAUDE.md                  deeper architecture/handoff notes
```

## Deploying

Production deploys are **manual** from the Netlify dashboard — git pushes (including branch
and PR previews) are suppressed by `ignore = "exit 0"` in `netlify.toml`. Read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before shipping.
