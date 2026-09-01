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
        signal: 'var(--signal)',
        good: 'var(--good)',
        flag: 'var(--flag)',
        muted: 'var(--muted)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { DEFAULT: '2px', sm: '2px', md: '2px' },
    },
  },
  plugins: [],
};
