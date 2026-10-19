/** @type {import('tailwindcss').Config} */
// Forked theme: black / white / one neon accent. Every colour in the app comes
// from these tokens (or src/theme.ts for canvas / SVG / chessboard props), so
// the whole look can be retuned here.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          0: '#050505',   // page
          1: '#0C0C0C',   // cards / tiles
          2: '#151515',   // raised / inputs
          3: '#1F1F1F',   // hover / tracks
        },
        border: {
          DEFAULT: '#1F1F1F',
          hover: '#2E2E2E',
        },
        text: {
          0: '#F5F5F5',
          1: '#A3A3A3',
          2: '#6B6B6B',
        },
        accent: {
          DEFAULT: '#C8FF2A',   // neon
          hover: '#D7FF5C',
          dim: 'rgba(200,255,42,0.12)',
          ink: '#050505',       // text on a neon surface
        },
        success: {
          DEFAULT: '#2EE6A6',
          dim: 'rgba(46,230,166,0.15)',
        },
        danger: {
          DEFAULT: '#FF4D5E',
          dim: 'rgba(255,77,94,0.15)',
        },
        warn: '#FFB020',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      boxShadow: {
        neon: '0 0 0 1px rgba(200,255,42,0.35), 0 0 24px -4px rgba(200,255,42,0.35)',
        'neon-sm': '0 0 12px -2px rgba(200,255,42,0.45)',
      },
      keyframes: {
        shake: {
          '0%,100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-6px)' },
          '40%': { transform: 'translateX(6px)' },
          '60%': { transform: 'translateX(-4px)' },
          '80%': { transform: 'translateX(4px)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-glow': {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(200,255,42,0)' },
          '50%':      { boxShadow: '0 0 0 4px rgba(200,255,42,0.25)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        shake:       'shake 0.5s ease-in-out',
        'fade-in':   'fade-in 0.3s ease-out',
        'pulse-glow':'pulse-glow 2s ease-in-out infinite',
        'slide-in':  'slide-in 0.25s ease-out',
      },
    },
  },
  plugins: [],
}
