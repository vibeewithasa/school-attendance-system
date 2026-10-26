import { defineConfig } from 'vitest/config';

// Pruebas de integracion con PostgreSQL local. Carga apps/api/.env si existe (ignorado por Git).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/integration/load-env.ts'],
    testTimeout: 15_000,
  },
});
