import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ command }) => ({
  // relative asset URLs in the build so it works from any sub-path (GitHub Pages)
  base: command === 'build' ? './' : '/',
  server: { port: 5230, open: false, hmr: false, host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), pad: resolve(__dirname, 'pad.html') } },
  },
}));
