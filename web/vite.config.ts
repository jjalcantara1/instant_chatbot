import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Matches the server's PORT. Overridable because 8080 is a popular port and is
// already taken on plenty of machines.
const apiTarget = process.env['API_TARGET'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/widget.js': { target: apiTarget, changeOrigin: true },
      '/healthz': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
