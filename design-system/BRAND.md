# Holder Distribution — design system

Holder Distribution tracks on-chain holder behavior — concentration, movement, and wallet activity — for crypto teams who need to see what's actually happening to a token's holder base, not just its price. The brand should read as **precise and current**: a tool built by people who look at chain data all day, not a marketing site dressed up to look serious.

## Voice

- Do: state the number, then the read. "Top 10 holders now control 34% of supply, up from 28% last week." Short sentences. Present tense for live state.
- Do: name the chain and the timeframe. On-chain claims are only useful when they're specific.
- Don't: hype words ("moon," "explosive," "don't miss out"), exclamation marks, vague timeframes ("recently," "lately").
- Don't: imply certainty about the future. Holder data describes what happened, not what will happen.

## Visual foundations

**Color.** One identity color — `brand`, a dark teal — carries the logo, primary actions, and the default chart series. It does not change between themes; a person should recognize the mark in light or dark mode. `accent`, a gold, is the one deliberate departure from teal: reserved for premium/featured moments (an upgrade prompt, a featured row) so it stays meaningful by staying rare — never a second everyday action color, and never a substitute for `warning`, which is a different token for a different job (caution, not celebration). `positive`/`negative` are a separate green/red pair reserved for actual holder movement (inflows, outflows, gains, losses) — never used decoratively, and never for anything teal or gold already mean. Every text color has a light and dark value tuned to hit 4.5:1 against the surface its usage note names.

**Type.** Inter for everything a person reads. IBM Plex Mono for anything that is a chain-native value — token amounts, balances, prices, wallet addresses, transaction hashes — so numbers and addresses are visually distinct from prose and easy to scan in a table. Labels (buttons, tabs, tags) are set in sentence case, never uppercase — the wordmark itself is mixed-case and the UI should match it.

**Shape.** The mark is built from angular, faceted cuts (the two arrows forming the H), not soft curves. UI radius stays modest — `radius-md` (8px) for controls, `radius-lg` (14px) for cards — deliberately short of the fully-rounded "friendly fintech" look, so the interface doesn't fight the mark's geometry. Pills (`radius-pill`) are reserved for tags, badges, and avatars, never buttons or cards.

**Elevation.** Prefer a `border` over a `shadow` for separating flat surfaces (cards in a grid, table rows). Reserve `shadow-sm`/`shadow-md` for things that float above the layout: dropdowns, popovers, a hover-lifted card.

## Iconography

The system ships one mark (`assets/Logos/`), not an icon set. For UI icons, use a single 24px stroke-icon set at 1.75px stroke weight (Lucide or Feather both fit — pick one and stay with it) in `currentColor`, so icons inherit `ink` or `ink-muted` like the text beside them. Never recolor an icon to `brand` unless it sits in a nav item's active state.

## Logo usage

Three lockups are provided:

- **Icon** (`holder-analytics-icon.svg`) — the mark alone. Use for favicons, app icons, avatars, and anywhere the wordmark won't be legible at size.
- **Stacked** (`holder-analytics-stacked.svg`) — icon above wordmark. The default for square or portrait placements: app icons, social cards, a centered page header.
- **Horizontal** (`holder-analytics-horizontal.svg`) — icon beside wordmark. The default for a nav bar, a document header, or anywhere width is more available than height.

**Clearspace:** keep empty space around any lockup equal to the height of the wordmark's cap-height "H" on all sides. **Minimum size:** 32px icon height on screen, 0.5in in print — below that, use the icon alone. **Color:** the mark is single-ink `brand` teal; on a dark or photographic background, use it in solid white instead of trying to recolor it. **Never:** stretch or skew it, recolor it to anything but `brand` or white, add a drop shadow, or place it on a background busy enough to fight its silhouette.

## Component guidelines

Buttons, badges, and stat cards are provided as a starting kit for the product UI — see each component's own README for usage rules. `positive`/`negative` badges are the only place semantic color should feel loud; everything else defaults to `ink` and `brand`.
