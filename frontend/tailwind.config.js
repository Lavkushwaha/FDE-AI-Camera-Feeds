module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}", "./public/index.html"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        canvas: "#090A0F",
        panel: "#12141C",
        card: "#181B26",
        cardHover: "#1F2332",
        subtle: "#1E2435",
        tcyan: "#06B6D4",
        tamber: "#F59E0B",
        tcrimson: "#EF4444",
        temerald: "#10B981",
      },
      fontFamily: {
        heading: ["'Barlow Condensed'", "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      keyframes: {
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 12px rgba(6,182,212,0.4)" },
          "50%": { boxShadow: "0 0 22px rgba(6,182,212,0.75)" },
        },
      },
      animation: {
        scanline: "scanline 3.2s linear infinite",
        pulseGlow: "pulseGlow 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
