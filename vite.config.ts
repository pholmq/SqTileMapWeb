import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Use root path for Vercel, and repo path for GitHub Pages
  base: process.env.VERCEL ? '/' : '/SqTileMapWeb/',
  plugins: [react()],
  publicDir: 'public',
  worker: { format: 'es' },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { target: 'es2022' },
});
