import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = 'http://127.0.0.1:4310';

// The production build is served by @rnpa/server under a strict CSP
// (script-src 'self'; style-src 'self'), so nothing may be inlined.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/auth': { target: SERVER, changeOrigin: true },
    },
  },
});
