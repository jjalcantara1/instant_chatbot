/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        card: 'var(--card)',
        ink: 'var(--ink)',
        rule: 'var(--rule)',
        accent: 'var(--accent)',
        flag: 'var(--flag)',
        muted: 'var(--muted)',
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: { DEFAULT: '0', sm: '0', md: '0' },
    },
  },
  plugins: [],
};
