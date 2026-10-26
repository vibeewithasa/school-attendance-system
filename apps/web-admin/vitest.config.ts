import { defineConfig } from 'vitest/config';

/** Pruebas de componentes con jsdom. NO son pruebas de navegador real: ver docs/architecture/auth-rbac.md §9.4. */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
