/**
 * ENTORNO AISLADO DE PRUEBAS (pnpm dev:sandbox): un clúster PostgreSQL 18 DESECHABLE en una carpeta temporal y un puerto
 * propio (no toca el servicio de Windows, eta15_dev, beauty_pos ni postgres), con el esquema real, cuentas FICTICIAS y la API
 * escuchando en http://127.0.0.1:3000 con MFA diferido (solo desarrollo local). Sirve para probar el formulario de login de
 * apps/web-admin (pnpm dev:web) sin crear usuarios en eta15_dev. Al pulsar Ctrl+C todo se destruye.
 *
 * Las contrasenas de las cuentas ficticias se generan al azar en CADA arranque y se muestran solo en esta terminal; no existen
 * contrasenas predeterminadas ni se guardan en ningun archivo.
 */
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { BOOTSTRAP_PROCEDURES, bootstrapFirstAuthority } from '../src/modules/auth/bootstrap.js';
import { createPasswordService } from '../src/modules/auth/password.js';
import { createPgSessionStore } from '../src/modules/auth/session-store-pg.js';
import { startApiCluster } from '../test/helpers/api-cluster.js';

const newPassword = () => `Sbx-${randomBytes(12).toString('base64url')}`;

async function main(): Promise<void> {
  console.log('Iniciando el entorno aislado (clúster PostgreSQL desechable)…');
  // --catalog-write aplica la PROPUESTA de privilegios 0002 (escritura del catalogo) SOLO en este clúster desechable; en
  // eta15_dev no se aplica sin autorizacion. Sin la opcion, las escrituras del catalogo responden 503 como en eta15_dev.
  const catalogWrite = process.argv.includes('--catalog-write');
  // --students-write aplica la propuesta 0003 (alumnos, matriculas, historial de grupo), tambien solo en este clúster.
  const studentsWrite = process.argv.includes('--students-write');
  const cluster = await startApiCluster(10, { catalogWrite, studentsWrite });
  // Aislamiento: el clúster desechable usa un puerto propio; jamas el del servicio de PostgreSQL de Windows (5432).
  if (cluster.pgt.port === 5432) {
    await cluster.stop();
    throw new Error('El entorno aislado no puede usar el puerto 5432');
  }
  const passwords = createPasswordService();
  const accounts: Array<{ rol: string; correo: string; contrasena: string }> = [];

  const bootstrap = async (domain: 'technical' | 'school', email: string, name: string) => {
    const password = newPassword();
    await bootstrapFirstAuthority(
      { domain, email, displayName: name, acta: 'ACTA-ENTORNO-AISLADO' },
      {
        client: cluster.owner,
        passwords,
        readPassword: async () => password,
        // Solo en este entorno desechable se simula la aprobacion del procedimiento escolar.
        procedures: {
          ...BOOTSTRAP_PROCEDURES,
          school: { ...BOOTSTRAP_PROCEDURES.school, approved: true },
        },
      },
    );
    return password;
  };
  const tecnicoPw = await bootstrap(
    'technical',
    'tecnico.ficticio@escuela.test',
    'Persona técnica ficticia',
  );
  const direccionPw = await bootstrap(
    'school',
    'direccion.ficticia@escuela.test',
    'Dirección ficticia',
  );
  accounts.push(
    { rol: 'admin_tecnico', correo: 'tecnico.ficticio@escuela.test', contrasena: tecnicoPw },
    { rol: 'direccion', correo: 'direccion.ficticia@escuela.test', contrasena: direccionPw },
  );

  // Control dual: quien crea una cuenta no aprueba su activacion, asi que el entorno trae DOS autoridades escolares ficticias
  // (la segunda se prepara con una fixture aislada; en una instalacion real la incorpora el procedimiento excepcional con acta).
  const direccion2Pw = newPassword();
  const d2 = await cluster.owner.query<{ id: string }>(
    `INSERT INTO users (email, display_name, account_domain, status, password_hash)
     VALUES ('direccion.dos.ficticia@escuela.test', 'Dirección dos ficticia', 'school', 'active', $1) RETURNING id`,
    [await passwords.hash(direccion2Pw)],
  );
  await cluster.owner.query(
    `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source)
     SELECT $1, r.id, r.domain, d.id, 'grant' FROM roles r, users d WHERE r.key = 'direccion' AND d.email = 'direccion.ficticia@escuela.test'`,
    [d2.rows[0]!.id],
  );
  accounts.push({
    rol: 'direccion (2.ª)',
    correo: 'direccion.dos.ficticia@escuela.test',
    contrasena: direccion2Pw,
  });

  const prefPw = newPassword();
  const pref = await cluster.owner.query<{ id: string }>(
    `INSERT INTO users (email, display_name, account_domain, status, password_hash)
     VALUES ('prefectura.ficticia@escuela.test', 'Prefectura ficticia', 'school', 'active', $1) RETURNING id`,
    [await passwords.hash(prefPw)],
  );
  await cluster.owner.query(
    `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source)
     SELECT $1, r.id, r.domain, d.id, 'grant' FROM roles r, users d WHERE r.key = 'prefectura' AND d.email = 'direccion.ficticia@escuela.test'`,
    [pref.rows[0]!.id],
  );
  accounts.push({
    rol: 'prefectura',
    correo: 'prefectura.ficticia@escuela.test',
    contrasena: prefPw,
  });

  const env = loadEnv({
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGIN: 'http://127.0.0.1:5173',
    AUTH_MFA_ENFORCEMENT: 'deferred',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(cluster.pgt.port),
    DB_NAME: 'eta15_dev',
    DB_USER: 'eta15_api',
  });
  const app = await buildApp(env, {
    auth: { store: createPgSessionStore(cluster.pool), passwords },
  });
  await app.listen({ host: env.HOST, port: env.PORT });

  console.log(
    '\nEntorno listo. API: http://127.0.0.1:3000   (abre el portal con  pnpm dev:web  en http://127.0.0.1:5173)',
  );
  console.log('Cuentas FICTICIAS de este arranque (se destruyen al salir):\n');
  // Las contrasenas son ficticias y solo viven en este arranque; aun asi no se escriben en salidas redirigidas a archivos:
  // solo se muestran en una terminal interactiva o si se pide expresamente con --show-credentials.
  if (process.stdout.isTTY || process.argv.includes('--show-credentials')) console.table(accounts);
  else
    console.log(
      '(credenciales omitidas: la salida no es una terminal; use --show-credentials para mostrarlas)',
    );
  console.log('Pulsa Ctrl+C para detener y destruir el entorno.');

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log('\nDeteniendo…');
    await app.close().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

await main();
