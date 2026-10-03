# Holder Analytics — design system

Exported snapshot of the Holder Analytics brand/design system, for use in code. This is a point-in-time copy — the live, editable version (where updates should be made first) is at:

https://claude.ai/artifact/2uD9F1N4qYTc1JPUx331Rs

## What's here

```
design-system/
├── BRAND.md              — voice, visual foundations, iconography, logo usage rules. Read this first.
├── tokens.json            — source of truth for every color, type, spacing, radius, and shadow value.
├── tokens.css              — tokens.json compiled to CSS custom properties (:root + [data-theme="dark"]).
├── logos/                  — icon, stacked, and horizontal SVG lockups (fixed-color, brand teal).
└── components/
    ├── bundle.js            — reference implementation of Button, Badge, StatCard.
    ├── bundle.css           — their styles, all driven by tokens.css variables.
    ├── index.d.ts           — TypeScript prop types for all three.
    ├── Button/README.md      — usage rules (when to use each variant).
    ├── Badge/README.md
    └── StatCard/README.md
```

## For Claude Code (or any agent building in this repo)

1. Read `BRAND.md` and `tokens.json` before writing any UI — they're the actual constraints, not suggestions (contrast ratios, color usage, spacing scale are all deliberate).
2. If the app is plain CSS/HTML: drop `tokens.css` in and use the `var(--token-name)` values directly — see any `usage` field in `tokens.json` for what each one is for.
3. If the app is React/another framework: `components/bundle.js` is **not** written as ES modules — it's global-script style (`window.HolderAnalytics.Button`, using `React.createElement` directly, no JSX) because that's what the source design-system artifact's runtime requires. Treat it as a **reference implementation**, not a drop-in import: port the same props (see `index.d.ts`) and the same CSS classes/variable usage (see `bundle.css`) into the repo's actual component conventions, rather than importing the file as-is.
4. If the app uses Tailwind or another token system: map `tokens.json`'s values into that system's config — don't hand-pick colors from the SVGs or guess hex values from screenshots.

## Keeping this in sync

This folder doesn't auto-update. When the brand kit changes (new token, new component, revised copy), re-export it from the link above and replace these files — check the diff before committing, since `tokens.css` and any hand-adapted components need to be regenerated/re-ported to match.
