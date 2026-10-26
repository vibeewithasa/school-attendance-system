import { defineConfig } from 'vitest/config';

// Pruebas unitarias: no requieren PostgreSQL. La integracion vive en vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    // Muchas suites crean bases PGlite (WASM) en paralelo; con la carga completa el limite por defecto de 5 s da falsos fallos.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/pgtemp/**', '**/node_modules/**'],
  },
});
