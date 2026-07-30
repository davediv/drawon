import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so a production build can be served from any path.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
});
