import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

/**
 * Apoyo del E2E web real. Todo es FICTICIO. La contrasena sale del entorno de esta ejecucion (E2E_PASSWORD) y nunca se escribe ni
 * se imprime. La base se consulta con el rol propietario del clúster DESECHABLE (puerto del archivo de estado), solo para VERIFICAR
 * lo que hizo el navegador contra los registros reales; jamas contra eta15_dev.
 */
export interface E2eState {
  dbPort: number;
  today: string;
  /** Cinco dias habiles anteriores a hoy (w1 el mas antiguo ... w5 el mas reciente). */
  weekdays: [string, string, string, string, string];
  year: string;
  groups: { A: string; B: string };
  students: Record<'ana' | 'beto' | 'carla' | 'diego' | 'elena' | 'fabi' | 'gael', string>;
  accounts: Record<
    'tecnico' | 'direccion' | 'prefecturaA' | 'prefecturaB' | 'trabajoSocial' | 'inactiva',
    string
  >;
}

export const state = (): E2eState =>
  JSON.parse(readFileSync(process.env.E2E_STATE_FILE!, 'utf8')) as E2eState;
export const password = (): string => process.env.E2E_PASSWORD!;

// `pg` ya es dependencia de apps/api: se resuelve desde alli (no se agrega al portal).
const requireFromApi = createRequire(join(process.cwd(), '..', 'api', 'package.json'));
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  end(): Promise<void>;
}
/** Consulta de SOLO verificacion contra el clúster desechable (rol propietario del clúster, sin contrasena: autenticacion de confianza local). */
export async function db<T>(run: (q: PgClient['query']) => Promise<T>): Promise<T> {
  const { Client } = requireFromApi('pg') as { Client: new (cfg: object) => PgClient };
  const client = new Client({
    host: '127.0.0.1',
    port: state().dbPort,
    user: 'eta15_app',
    database: 'eta15_dev',
  });
  await client.connect();
  try {
    return await run(client.query.bind(client));
  } finally {
    await client.end();
  }
}

/** Inicia sesion POR LA INTERFAZ (cookie, CSRF y Origin reales) y espera el panel autenticado. */
export async function loginAs(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password());
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
}

export const NOTICE_FOLLOWUP =
  'Los conteos reflejan únicamente ausencias registradas. No incluyen reglas de justificantes ni representan alertas oficiales.';
export const NOTICE_RECEIPT =
  'El registro de recepción no modifica la asistencia ni acredita la justificación de una falta.';

/** Huella de TODA la asistencia (listas, renglones y eventos): debe ser identica tras registrar justificantes. */
export const attendanceFingerprint = () =>
  db(async (q) =>
    JSON.stringify([
      (await q(`select id, status, revision from attendance_days order by id`)).rows,
      (await q(`select id, status, marked_by, marked_at from attendance_records order by id`)).rows,
      (await q(`select id, event_type, old_status, new_status from attendance_events order by id`))
        .rows,
    ]),
  );
