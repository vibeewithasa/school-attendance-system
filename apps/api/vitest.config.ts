import { defineConfig } from 'vitest/config';

// Pruebas unitarias: no requieren PostgreSQL. La integracion vive en vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/integration/**', '**/node_modules/**'],
  },
});
