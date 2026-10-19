# Deployment & production-readiness runbook

## How deploys work

- Host: Netlify. Build: `npm run build`, publish `dist/`, functions in `netlify/functions`.
- `netlify.toml` sets `ignore = "exit 0"` for the **production**, **deploy-preview** and
  **branch-deploy** contexts, so a push or PR **does not build** by design (data-refresh
  commits land on `main` daily and reach the site via the live-data function, see below). To ship: merge to `main`, then
  *Netlify → Deploys → Trigger deploy → Deploy site*.
- If you ever see builds starting on push, the Netlify UI is overriding `netlify.toml`
  (Site settings → Build & deploy → Build settings / Continuous deployment). Re-check there
  and run `npm run audit:deploys`.
- Put `[skip netlify]` in a commit message to be doubly sure a push never builds.

## Pre-deploy checklist

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
npm run preview        # click through Holders / Distribution / Supply at 390, 820, 1440 px
npm run check:feeds    # feeds validate and are consistent
```

Then confirm in the deployed site: response headers (below), `/robots.txt`, `/sitemap.xml`,
`/manifest.json`, share preview (`/og-image.png`), and that the "Data feed delayed"
banner is not showing (it means `public/data` is >48 h stale — see Data pipeline).

## Environment & secrets

| Where | Variable | Notes |
|---|---|---|
| Browser (build time) | `VITE_SITE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_HOLDER_HISTORY_URL` | All optional; **public** values only. Anything `VITE_*` is shipped to every visitor. |
| Netlify function | `FORENSICS_PASSWORD`, `SUPABASE_SECRET_KEY` | Netlify → Environment variables. Never commit. |
| GitHub Actions | `ENV_PASSPHRASE` | Decrypts `.env.enc` (RPC/Etherscan/Dune keys) for the pipeline. |

`.env`, `.env.local` are git-ignored; `.env.enc` is the only committed (encrypted) env file.

### Known security caveats (not changed here — need an owner decision)

- `src/lib/forensicsPasswordHash.ts` holds an unsalted SHA-256 of the forensics gate password
  (server-side only, absent from `dist/`). Treat the gate as "off the public web", not secret;
  prefer setting `FORENSICS_PASSWORD` in Netlify and removing the hash/rotating the password.
- The forensics function answers with `Access-Control-Allow-Origin: *` and an in-memory,
  per-instance rate limiter. Restrict the origin to `https://holderdistribution.com` if the
  gate is only used from the site.
- `npm audit --omit=dev` reports advisories in the Tailwind 3 build tool chain
  (`braces`/`chokidar`/`micromatch`, build-time only, nothing is shipped) and `react-router`
  6.x (open-redirect via backslash in `<Link>`, SSR `deserializeErrors` — neither applies: no
  user-supplied link targets, no SSR). Clearing them requires major upgrades
  (Tailwind 4, react-router 7); schedule those separately. Dependabot is enabled.

## Security headers

Set in `netlify.toml` for `/*`: HSTS (preload), `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin` and a
**Content-Security-Policy** (`script-src 'self'`; styles allow inline for Recharts/Radix/Framer;
fonts from Google Fonts; `connect-src` limited to self + the Supabase project).
Adding a third-party script, font, image host or API means adding its origin to the CSP, or the
browser will block it. Verify after deploy with
`curl -sI https://holderdistribution.com | grep -i -E 'content-security|strict-transport'`
and an empty browser console on all three tabs.

## Data pipeline (daily) and live data (no rebuild)

**Schedule.** One scheduled workflow, *Refresh TEL holders snapshot*
(`refresh-tel-holders.yml`, 00:00 UTC daily), runs every stage in one job: staker balances →
holders scan → derived feeds → commit → exchange flows → tier outflows → history-gap fill →
consistency gate → commit. `scan-exchange-flows`, `generate-tier-outflows` and
`fill-history-gaps` are manual (`workflow_dispatch`) backfill tools now; `pipeline-watchdog`
runs weekly (Mon), `detect-cex-candidates` weekly, `sync-cex-wallets` on the 1st/15th.
The log scanners run with `RPC_PREFER_PUBLIC=1` (keyless public RPCs take wide `eth_getLogs`
ranges; the Alchemy free tier's 10-block cap made the holders step alone ~23 min/day) and
retry on the Alchemy keys if that fails. Expected cost: ~15–30 Actions min/day, i.e.
~500–900 of the 2,000 free minutes/month (was ~2,500/month with the chained jobs, fallback
crons and daily watchdog).

**Live data.** Data commits do not rebuild Netlify. The browser fetches feeds from
`/live-data/<file>` (`netlify/functions/live-data.mjs`), which reads the latest
`public/data/<file>` from GitHub and is cached at Netlify's durable edge for 1 h
(stale-while-revalidate 24 h), so it runs at most ~once per file per hour regardless of
traffic. Without a token, or on any GitHub error, it 302s to the deployed static
`/data/<file>` (the pre-existing behaviour). It also strips per-address balances from
`holders-checkpoint.json` (~5 MB → <1 KB per visit).

One-time setup (required for live data; the site keeps working without it):

1. GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*.
   Repository access: only `fabcrowd/holderdistribution`. Permissions: **Contents: Read-only**
   (nothing else). Pick an expiry and calendar a renewal.
2. Netlify → Site configuration → Environment variables → add `LIVE_DATA_GITHUB_TOKEN` =
   that token (scope: Functions). Optional: `LIVE_DATA_REF` (default `main`),
   `LIVE_DATA_REPO` (default `fabcrowd/holderdistribution`).
3. Deploys → Trigger deploy → Deploy site (env vars only reach functions after a deploy).
4. Check: `curl -sI https://holderdistribution.com/live-data/holders-lite.json` shows
   `x-live-data: github`. `fallback: not configured` means step 2/3 did not take.

Cost of this path on Netlify credits: function compute ≤ ~20 credits/month worst case (all 11
files re-fetched every hour, ~1 s at 1 GB each), typically a few; web requests
2 credits/10k; versus 15 credits per production deploy (a daily deploy = ~450/month, over
the Free plan's 300). If GitHub Actions is billing-blocked, nothing new is committed and
the site keeps serving the last committed data (the "Data feed delayed" banner shows the age).

## Rollback

Netlify → Deploys → pick the last good deploy → *Publish deploy*. Data feeds roll back with it.

## Monitoring suggestions

- Uptime check on `/` and `/data/holders-lite.json` (alert if `generatedAt` > 48 h old).
- Watch the `pipeline-failure` GitHub label.
