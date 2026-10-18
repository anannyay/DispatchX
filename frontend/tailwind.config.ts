import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#ecfdf5", 100: "#d1fae5", 400: "#34d399", 500: "#10b981",
          600: "#059669", 700: "#047857", 900: "#064e3b",
        },
        ink: { 900: "#0b1220", 800: "#111a2e", 700: "#1a2540", 600: "#26324f" },
      },
      boxShadow: { card: "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)" },
      keyframes: { pulseRing: { "0%": { transform: "scale(.8)", opacity: ".8" }, "100%": { transform: "scale(2.2)", opacity: "0" } } },
      animation: { pulseRing: "pulseRing 1.6s ease-out infinite" },
    },
  },
  plugins: [],
} satisfies Config;
