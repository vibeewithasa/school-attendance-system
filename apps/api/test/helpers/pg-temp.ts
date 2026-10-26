import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';

/**
 * Clúster PostgreSQL 18 DESECHABLE para pruebas de concurrencia real (varias conexiones).
 * - Usa los binarios instalados (initdb/pg_ctl) pero un directorio temporal propio y un puerto libre en
 *   127.0.0.1: NO toca el servicio de Windows, eta15_dev ni ninguna otra base.
 * - Autenticacion trust SOLO en ese clúster efimero (loopback); se destruye al terminar.
 * - Falla de forma explicita si no encuentra los binarios (no se omite en silencio). PG_BIN lo sobrescribe.
 */
const PG_BIN = process.env.PG_BIN ?? 'C:\\Program Files\\PostgreSQL\\18\\bin';
const exe = (name: string) => join(PG_BIN, `${name}.exe`);

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 2).join(' ')} fallo (${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`,
    );
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface TempPostgres {
  port: number;
  /** Nueva conexion; por defecto como superusuario/propietario postgres. */
  connect(user?: string, database?: string): Promise<pg.Client>;
  stop(): Promise<void>;
}

export async function startTempPostgres(): Promise<TempPostgres> {
  for (const bin of ['initdb', 'pg_ctl']) {
    if (!existsSync(exe(bin)))
      throw new Error(
        `No se encontro ${exe(bin)}. Defina PG_BIN con el directorio bin de PostgreSQL 18.`,
      );
  }
  const dir = mkdtempSync(join(tmpdir(), 'eta15-pgtmp-'));
  const port = await freePort();
  run(exe('initdb'), [
    '-D',
    dir,
    '-U',
    'postgres',
    '-A',
    'trust',
    '-E',
    'UTF8',
    '--locale=C',
    '--no-instructions',
  ]);
  // stdio 'ignore': el servidor hereda los descriptores; con pipes spawnSync no regresaria nunca.
  const started = spawnSync(
    exe('pg_ctl'),
    [
      'start',
      '-D',
      dir,
      '-w',
      '-s',
      '-l',
      join(dir, 'server.log'),
      '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`,
    ],
    { stdio: 'ignore', windowsHide: true, timeout: 60_000 },
  );
  if (started.status !== 0) {
    spawnSync(exe('pg_ctl'), ['stop', '-D', dir, '-m', 'immediate', '-s'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`pg_ctl start fallo (${started.status})`);
  }
  const clients: pg.Client[] = [];
  return {
    port,
    async connect(user = 'postgres', database = 'postgres') {
      const c = new pg.Client({ host: '127.0.0.1', port, user, database });
      await c.connect();
      clients.push(c);
      return c;
    },
    async stop() {
      await Promise.allSettled(clients.map((c) => c.end()));
      spawnSync(exe('pg_ctl'), ['stop', '-D', dir, '-m', 'immediate', '-w', '-s'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 60_000,
      });
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    },
  };
}

/** Aplica todas las migraciones de apps/api/drizzle con el mismo lector que usa el migrador de Drizzle. */
export async function applyMigrations(client: pg.Client): Promise<void> {
  const dir = join(import.meta.dirname, '..', '..', 'drizzle');
  for (const migration of readMigrationFiles({ migrationsFolder: dir })) {
    for (const stmt of migration.sql) await client.query(stmt);
  }
}
