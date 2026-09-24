import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(process.cwd(), 'dashboard'),
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(process.cwd(), 'dist-dashboard'),
    emptyOutDir: true,
    sourcemap: false,
  },
});

