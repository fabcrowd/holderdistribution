// Strict three-way classification used everywhere in the tier diagram: GREEN =
// buy pressure, RED = sell pressure, YELLOW = redistribution (LP / wallet
// moves, no market buy or sell). Same palette in both Wallets and TEL modes.
export const GREEN = "hsl(142 71% 45%)";
export const RED = "hsl(0 72% 55%)";
export const YELLOW = "hsl(48 95% 50%)";
export const POSITIVE = GREEN;
export const NEGATIVE = RED;
export const NEUTRAL = YELLOW;
// Darker variants for text on tinted backgrounds: GREEN/RED are chart fills
// and fail 4.5:1 as small text.
export const POSITIVE_TEXT = "hsl(var(--tier-positive-text))";
export const NEGATIVE_TEXT = "hsl(var(--tier-negative-text))";
export const MUTED = "hsl(var(--muted-foreground))";

/** Dash pattern for redistribution lines, so they differ from buy/sell by more than colour. */
export const REDISTRIBUTION_DASH = "7 5";

export type Tone = "positive" | "negative" | "neutral";

/** Readable text colour for a tone (neutral inherits the surrounding text colour). */
export const textColorForTone = (tone: Tone): string | undefined =>
  tone === "positive" ? POSITIVE_TEXT : tone === "negative" ? NEGATIVE_TEXT : undefined;
