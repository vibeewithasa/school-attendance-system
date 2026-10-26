/**
 * Dispensa EXCEPCIONAL del control dual para incorporar a la SEGUNDA autoridad de un dominio:
 *   pnpm auth:second-authority -- --email <correo de la cuenta pendiente> --acta "<referencia del acta>" [--hours 24]
 *
 * Procedimiento de consola, separado de la API (no existe endpoint): usa la identidad del migrador (eta15_app). Solo se concede
 * para UNA cuenta pendiente que ya tiene un rol de autoridad y mientras el dominio tenga una sola autoridad activa; caduca y
 * se consume una vez; queda en auditoria. El dominio ESCOLAR esta BLOQUEADO hasta que exista el procedimiento institucional.
 * No recibe ni imprime contrasenas. Ver docs/architecture/auth-rbac.md §6.
 */
import { stdin, stderr } from 'node:process';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { WaiverError, grantSecondAuthorityWaiver } from '../src/modules/activation/dual-control.js';
import { checkOwnerConnection, readEnvFile, safeError } from './db-identity.js';

const USAGE = `Uso: pnpm auth:second-authority -- --email <correo> --acta "<referencia del acta>" [--hours 24]`;

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
      email: { type: 'string' },
      acta: { type: 'string' },
      hours: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.email || !values.acta) {
    console.error(USAGE);
    return 2;
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
      'DISPENSA EXCEPCIONAL del control dual (segunda autoridad de un dominio).',
      'Autoriza que QUIEN CREO la cuenta apruebe, una sola vez y dentro del plazo, su activacion presencial.',
      'El acta es evidencia, no sustituye la autorizacion institucional. Queda auditado.',
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
    const result = await grantSecondAuthorityWaiver(
      {
        email: values.email,
        acta: values.acta,
        hours: values.hours ? Number(values.hours) : undefined,
      },
      { client },
    );
    console.log(
      `Dispensa concedida (${result.waiverId}) para la cuenta ${result.userId}; vence ${result.expiresAt.toISOString()}.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof WaiverError) {
      console.error(
        `${error.code === 'procedure_blocked' ? 'BLOQUEADO' : 'No se concedio la dispensa'} [${error.code}]: ${error.message}`,
      );
      return error.code === 'procedure_blocked' ? 3 : 1;
    }
    console.error(`Error inesperado: ${safeError(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

process.exitCode = await main();
