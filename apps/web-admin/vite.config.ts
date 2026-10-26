import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // En desarrollo las llamadas a /api se redirigen a la API local.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
