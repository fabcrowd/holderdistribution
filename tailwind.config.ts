import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['"Inter"', "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", '"SF Mono"', "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /* Holder Analytics semantic tokens */
        brand: {
          DEFAULT: "hsl(var(--ha-brand))",
          hover: "hsl(var(--ha-brand-hover))",
          tint: "hsl(var(--ha-brand-tint))",
        },
        positive: {
          DEFAULT: "hsl(var(--ha-positive))",
          tint: "hsl(var(--ha-positive-tint))",
        },
        negative: {
          DEFAULT: "hsl(var(--ha-negative))",
          tint: "hsl(var(--ha-negative-tint))",
        },
        warning: {
          DEFAULT: "hsl(var(--ha-warning))",
        },
        "ha-accent": {
          DEFAULT: "hsl(var(--ha-accent))",
          tint: "hsl(var(--ha-accent-tint))",
        },
        link: "hsl(var(--ha-link))",
        status: {
          review: "hsl(var(--status-review))",
          passed: "hsl(var(--status-passed))",
          implemented: "hsl(var(--status-implemented))",
          rejected: "hsl(var(--status-rejected))",
        },
        action: {
          blue: "hsl(var(--action-blue))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",       /* 14px — cards, panels, modals */
        md: "var(--radius-md)",    /* 8px  — buttons, inputs */
        sm: "var(--radius-sm)",    /* 4px  — badges, tags */
        pill: "var(--radius-pill)", /* 999px — pills, avatars */
      },
      boxShadow: {
        sm: "0 1px 2px rgba(14,20,20,0.06)",
        md: "0 4px 16px rgba(14,20,20,0.10)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          "0%": { transform: "scale(0.95)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.6s ease-out",
        "scale-in": "scale-in 0.3s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
