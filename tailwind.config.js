/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#060607', 800: '#0A0B0D', 700: '#0F1013', 600: '#151619', 500: '#1C1D21' },
        line: { DEFAULT: '#24252A', 2: '#303238' },
        brand: {
          red: '#E50E05',
          redDark: '#A80903',
          redSoft: '#FF3B31',
          gold: '#E4BE54',
          goldDeep: '#AC7C3E',
          cream: '#F5EDCE'
        },
        txt: { DEFAULT: '#F7F7F5', dim: '#A6ABB1', faint: '#70767C' }
      },
      fontFamily: {
        sans: ['Cairo', 'Segoe UI', 'Tahoma', 'sans-serif']
      },
      borderRadius: {
        '4xl': '2rem',
        panel: '1.5rem'
      },
      boxShadow: {
        glow: '0 0 44px rgba(229,14,5,0.22)',
        gold: '0 0 32px rgba(228,190,84,0.14)',
        card: '0 22px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)',
        lift: '0 28px 70px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)'
      },
      keyframes: {
        fadeUp: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        pop: { '0%': { opacity: '0', transform: 'scale(0.97) translateY(4px)' }, '100%': { opacity: '1', transform: 'scale(1) translateY(0)' } },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } }
      },
      animation: {
        fadeUp: 'fadeUp .32s cubic-bezier(.22,.8,.28,1)',
        pop: 'pop .2s cubic-bezier(.22,.8,.28,1)',
        shimmer: 'shimmer 1.4s linear infinite'
      }
    }
  },
  plugins: []
}
