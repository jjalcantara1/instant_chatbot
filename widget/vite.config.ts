import { defineConfig } from 'vite';

// Single-file IIFE. No framework, no code splitting, no external imports.
export default defineConfig({
  build: {
    lib: { entry: 'src/widget.ts', name: 'KleioSiteChat', formats: ['iife'], fileName: () => 'widget.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'es2019',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
