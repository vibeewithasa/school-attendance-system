import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * E2E WEB REAL (navegador Chrome del equipo + API Fastify real + PostgreSQL 18 DESECHABLE). Sin mocks ni intercepcion de respuestas:
 * cookies de sesion, CSRF, Origin, autenticacion y autorizacion son las de la API. La pila (apps/api/scripts/e2e-stack.ts) crea un
 * clúster temporal con datos FICTICIOS y nunca toca eta15_dev. Ejecutar:  . .\tools\env.ps1; pnpm test:e2e
 *
 * La contrasena de las cuentas ficticias se genera al azar en CADA ejecucion y solo vive en el entorno de estos procesos (no se
 * escribe en ningun archivo ni se imprime). El archivo de estado (sin secretos: puerto del clúster y fechas) va a la carpeta temporal.
 */
process.env.E2E_PASSWORD ??= `E2e-${randomBytes(16).toString('base64url')}`;
process.env.E2E_STATE_FILE ??= join(tmpdir(), `eta15-e2e-${process.pid}.json`);

export default defineConfig({
  testDir: './e2e',
  // Un solo trabajador y orden fijo: los escenarios comparten la misma base desechable y algunos escriben (justificantes).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // Chrome instalado en el equipo (no se descarga ningun navegador). Si se prefiere Edge: E2E_CHANNEL=msedge.
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: true,
    locale: 'es-MX',
    timezoneId: 'America/Mazatlan',
    // Sin trazas ni video: podrian contener cookies o la contrasena ficticia de la ejecucion.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // API real + PostgreSQL 18 desechable + datos ficticios (tarda: arranca un clúster).
      command: 'pnpm --filter @eta15/api e2e:stack',
      cwd: '../..',
      url: 'http://127.0.0.1:3000/health',
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // Portal React/Vite real (el proxy /api -> 127.0.0.1:3000 es el de vite.config.ts).
      command: 'pnpm dev:web',
      cwd: '../..',
      url: 'http://127.0.0.1:5173',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
