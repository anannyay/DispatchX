import type { Config } from "tailwindcss";

// Palette lifted from kepler.gl's theme (src/styles/src/base.ts) so the app and
// the embedded Kepler map read as one product.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        k: {
          canvas: "#1C1F26",   // app background
          side: "#242730",     // kepler sidePanelBg
          panel: "#29323C",    // kepler panelBackground / inputBgd
          hover: "#3A4552",    // kepler panelBackgroundHover
          line: "#3A414C",     // kepler panelBorderColor
          label: "#6A7485",    // kepler labelColor
          text: "#A0A7B4",     // kepler textColor
          hi: "#F0F0F0",       // kepler textColorHl
          accent: "#1FBAD6",   // kepler activeColor
          go: "#0F9668",       // kepler primaryBtnBgd
          gohover: "#13B17B",
          warn: "#F0B429",
          err: "#F25F5C",
          violet: "#A08CF5",
          ok: "#2EC27E",
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "Helvetica Neue", "Helvetica", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", "14px"],
        xs: ["11px", "16px"],
        sm: ["12px", "18px"],
        base: ["13px", "20px"],
      },
      borderRadius: { DEFAULT: "3px", md: "4px", lg: "6px" },
      keyframes: {
        fadeIn: { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        ping2: { "0%": { transform: "scale(1)", opacity: ".7" }, "100%": { transform: "scale(2.4)", opacity: "0" } },
      },
      animation: { fadeIn: "fadeIn .18s ease-out", ping2: "ping2 1.6s ease-out infinite" },
    },
  },
  plugins: [],
} satisfies Config;
