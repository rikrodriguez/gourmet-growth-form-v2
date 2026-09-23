import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/form2/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
