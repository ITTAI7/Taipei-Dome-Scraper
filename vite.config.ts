import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      ignored: [
        '**/browser_data_*/**',
        '**/browser_data_*',
        '**/debug_*.html',
        '**/*.png',
      ],
    },
  },
});