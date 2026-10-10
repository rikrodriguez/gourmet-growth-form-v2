import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: resolve(process.cwd(), 'office'),
  base: '/office/',
  plugins: [react()],
  resolve: { alias: { '/src': resolve(process.cwd(), 'src') } },
  server: { host: '127.0.0.1', port: 4175, strictPort: true, fs: { allow: [process.cwd()] }, proxy: { '/office-api': { target: 'http://127.0.0.1:4180' } } },
  build: { outDir: resolve(process.cwd(), 'dist-office'), emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true, proxy: { '/office-api': { target: 'http://127.0.0.1:4180' } } },
});
