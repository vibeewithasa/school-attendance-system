import { defineConfig } from 'vitest/config';

// Concurrencia real en un cluster PostgreSQL 18 DESECHABLE (carpeta temporal, puerto propio, loopback).
// No usa eta15_dev. Requiere los binarios de PostgreSQL 18 (PG_BIN); falla de forma explicita si no existen.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/pgtemp/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
