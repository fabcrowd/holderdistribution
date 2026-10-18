# Deployment & production-readiness runbook

## How deploys work

- Host: Netlify. Build: `npm run build`, publish `dist/`, functions in `netlify/functions`.
- `netlify.toml` sets `ignore = "exit 0"` for the **production**, **deploy-preview** and
  **branch-deploy** contexts, so a push or PR **does not build** by design (data-refresh
  commits land on `main` many times a day). To ship: merge to `main`, then
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
`/manifest.json`, share preview (`/og-image.png`), and that the "Feed error — node offline"
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

## Data pipeline

Scheduled GitHub Actions (`refresh-tel-holders`, `scan-exchange-flows`, `generate-tier-outflows`,
`fill-history-gaps`, `detect-cex-candidates`, `pipeline-watchdog`, …) commit fresh JSON to
`public/data/` and `data/`. As of 2026-10-18 **all of them fail within ~3–4 s with no step logs**
(issues #1–#6): that signature is an account-level Actions block (billing/spending limit),
not a code fault — see the note in `pipeline-watchdog.yml`. Until Actions is re-enabled the site
serves feeds last updated 2026-10-02 and shows a stale-data banner. Fix: GitHub → Settings →
Billing → Actions, then re-run *Refresh TEL holders snapshot* and close the issues.

## Rollback

Netlify → Deploys → pick the last good deploy → *Publish deploy*. Data feeds roll back with it.

## Monitoring suggestions

- Uptime check on `/` and `/data/holders-lite.json` (alert if `generatedAt` > 48 h old).
- Watch the `pipeline-failure` GitHub label.
