/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          0: '#0B0B0F',
          1: '#111118',
          2: '#1A1A25',
          3: '#242436',
        },
        border: {
          DEFAULT: '#242436',
          hover: '#363650',
        },
        text: {
          0: '#EEEEF2',
          1: '#8A8AA4',
          2: '#5A5A72',
        },
        accent: {
          DEFAULT: '#7B61FF',
          hover: '#8F77FF',
          dim: 'rgba(123,97,255,0.12)',
        },
        success: {
          DEFAULT: '#0DC97F',
          dim: 'rgba(13,201,127,0.15)',
        },
        danger: {
          DEFAULT: '#FF4D4D',
          dim: 'rgba(255,77,77,0.15)',
        },
        warn: '#F59E0B',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
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
          '0%,100%': { boxShadow: '0 0 0 0 rgba(123,97,255,0)' },
          '50%':      { boxShadow: '0 0 0 4px rgba(123,97,255,0.25)' },
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
