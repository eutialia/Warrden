import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dashboard ships inside the server's image, so the version worth showing is
// the product's, not this workspace's own placeholder.
const { version } = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
) as { version: string };

// https://vite.dev/config/
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:9797' },
  },
  // The suite covers the adapter layer — the pure functions that turn a job detail into
  // feed rows. No jsdom: rendering is verified against the running app, not simulated.
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
