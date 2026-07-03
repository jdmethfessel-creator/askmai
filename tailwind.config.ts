import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ivory: "var(--ivory)",
        card: "var(--card)",
        taupe: "var(--taupe)",
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        bronze: "var(--bronze)",
        "bronze-deep": "var(--bronze-deep)",
        graphite: "var(--graphite)",
        line: "var(--line)",
        accent: "var(--accent)",
        bg: "var(--bg)",
        muted: "var(--muted)",
        surface: "var(--surface)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Bodoni Moda", "Georgia", "serif"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        hand: ["var(--font-hand)", "cursive"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["var(--font-display)", "Bodoni Moda", "Georgia", "serif"],
      },
      boxShadow: {
        tag: "2.5px 2.5px 0 var(--taupe)",
        "tag-sm": "2px 2px 0 var(--taupe)",
      },
      borderRadius: {
        bubble: "16px 16px 3px 16px",
        "bubble-l": "16px 16px 16px 3px",
      },
    },
  },
  plugins: [],
};

export default config;
