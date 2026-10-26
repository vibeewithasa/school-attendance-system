/**
 * Bootstrap controlado de la primera autoridad de un dominio:  pnpm auth:bootstrap -- --domain technical ...
 *
 * Procedimiento de consola SEPARADO de la API. Usa la identidad del migrador (eta15_app, apps/api/.env.migrator) porque los
 * triggers de la base solo aceptan el bootstrap del propietario. Debe ejecutarlo la PERSONA titular (o con ella presente) en
 * una terminal interactiva: la contrasena se teclea en un prompt oculto, nunca se acepta por argumentos, variables de entorno,
 * archivos ni tuberias, y no se imprime. Ver docs/architecture/auth-rbac.md §5.
 */
import { stdin, stderr } from 'node:process';
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  BOOTSTRAP_PROCEDURES,
  BootstrapError,
  bootstrapFirstAuthority,
  type BootstrapDomain,
} from '../src/modules/auth/bootstrap.js';
import { createPasswordService } from '../src/modules/auth/password.js';
import { checkOwnerConnection, readEnvFile, safeError } from './db-identity.js';

const USAGE = `Uso: pnpm auth:bootstrap -- --domain <technical|school> --email <correo> --name "<nombre completo>" --acta "<referencia del acta>"
La contrasena NO se pasa por argumentos: la teclea la persona titular cuando se le solicita.`;

/** Lee una linea sin eco. Exige una terminal interactiva (rechaza tuberias y redirecciones). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(
        new Error(
          'Se requiere una terminal interactiva: la contrasena no se acepta por tuberia ni archivo',
        ),
      );
      return;
    }
    stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelado por la persona usuaria'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readLine(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      domain: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      acta: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.domain || !values.email || !values.name || !values.acta) {
    console.error(USAGE);
    return 2;
  }
  if (values.domain !== 'technical' && values.domain !== 'school') {
    console.error('--domain debe ser technical o school');
    return 2;
  }
  const domain: BootstrapDomain = values.domain;
  const procedure = BOOTSTRAP_PROCEDURES[domain];
  if (!procedure.approved) {
    console.error(`BLOQUEADO: ${procedure.blockedReason}`);
    return 3;
  }

  const env = readEnvFile('.env.migrator');
  if (!env) {
    console.error('Falta apps/api/.env.migrator (tools\\set-db-password.ps1 -Target migrator).');
    return 2;
  }
  try {
    await checkOwnerConnection(env);
  } catch (error) {
    console.error(`Identidad del migrador no valida: ${safeError(error)}`);
    return 2;
  }

  console.error(
    [
      '',
      `BOOTSTRAP de la primera autoridad del dominio "${domain}" (rol ${procedure.role}).`,
      'Esta operacion ocurre UNA sola vez por dominio y queda auditada. El acta es evidencia, no sustituye la autorizacion',
      'institucional. La persona titular debe estar presente y teclear su propia contrasena; no la comparta con nadie.',
      `Cuenta: ${values.email}   Acta: ${values.acta}`,
      '',
    ].join('\n'),
  );
  const typed = await readLine(
    `Para confirmar escriba exactamente la referencia del acta (${values.acta}): `,
  );
  if (typed !== values.acta.trim()) {
    console.error('La confirmacion no coincide; no se hizo ningun cambio.');
    return 1;
  }

  const client = new pg.Client({
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME ?? 'eta15_dev',
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const result = await bootstrapFirstAuthority(
      { domain, email: values.email, displayName: values.name, acta: values.acta },
      {
        client,
        passwords: createPasswordService(),
        readPassword: async () => {
          const first = await readHidden('Contraseña de la persona titular (no se muestra): ');
          const second = await readHidden('Repita la contraseña: ');
          if (first !== second)
            throw new BootstrapError('password_rejected', 'Las contraseñas no coinciden');
          return first;
        },
      },
    );
    console.log(
      `Listo: cuenta ${result.userId} activa con el rol ${result.role} (dominio ${result.domain}). Operacion auditada.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error(`No se realizo el bootstrap [${error.code}]: ${error.message}`);
      return 1;
    }
    console.error(`Error inesperado: ${safeError(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

process.exitCode = await main();
