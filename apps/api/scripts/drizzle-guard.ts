import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Protecciones sencillas contra ejecuciones accidentales de Drizzle (p. ej. un esquema vacio que
 * generaria DROP TABLE). Se usan desde scripts/db-generate.ts y scripts/db-migrate.ts.
 * Las funciones puras estan cubiertas por test/drizzle-guard.test.ts.
 */

export const API_DIR = resolve(import.meta.dirname, '..');
export const DRIZZLE_DIR = join(API_DIR, 'drizzle');
export const SCHEMA_DIR = join(API_DIR, 'src', 'db', 'schema');
/** Una migracion con esta marca (escrita a mano, deliberadamente) puede contener operaciones destructivas. */
export const ALLOW_DESTRUCTIVE_MARKER = '-- eta15:allow-destructive';

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  version?: string;
  breakpoints?: boolean;
}

const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN|CONSTRAINT|INDEX|TRIGGER|FUNCTION|TYPE|ROLE|EXTENSION)\b/i,
  /(^|\bBEGIN\b|\bTHEN\b|\bELSE\b)\s*TRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
];

/** Sentencias potencialmente destructivas de un SQL (vacio si lleva la marca de autorizacion manual). */
export function destructiveStatements(sql: string): string[] {
  if (sql.includes(ALLOW_DESTRUCTIVE_MARKER)) return [];
  const code = sql.replace(/--.*$/gm, '');
  return code
    .split(/;|-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s && DESTRUCTIVE.some((re) => re.test(s)))
    .map((s) => s.replace(/\s+/g, ' ').slice(0, 120));
}

/** Coherencia interna del journal: indices consecutivos, etiquetas con su indice y marcas crecientes. */
export function journalProblems(entries: JournalEntry[]): string[] {
  const problems: string[] = [];
  entries.forEach((e, i) => {
    if (e.idx !== i) problems.push(`idx ${e.idx} fuera de orden (se esperaba ${i})`);
    if (!e.tag.startsWith(String(i).padStart(4, '0') + '_')) {
      problems.push(`la etiqueta ${e.tag} no corresponde al indice ${i}`);
    }
    if (i > 0 && e.when <= entries[i - 1]!.when) {
      problems.push(`la marca de tiempo de ${e.tag} no supera la de la anterior`);
    }
  });
  return problems;
}

/** El journal confirmado en HEAD debe ser un prefijo identico del journal actual (no se reescribe historial). */
export function headPrefixProblems(head: JournalEntry[], current: JournalEntry[]): string[] {
  const problems: string[] = [];
  head.forEach((h, i) => {
    const c = current[i];
    if (!c) problems.push(`falta la migracion confirmada ${h.tag}`);
    else if (c.tag !== h.tag || c.when !== h.when || c.idx !== h.idx) {
      problems.push(`la entrada ${h.tag} del journal fue modificada`);
    }
  });
  return problems;
}

export function countPgTables(source: string): number {
  return (source.match(/\bpgTable\s*\(/g) ?? []).length;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: API_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function gitOk(args: string[]): boolean {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

export function readJournal(dir = DRIZZLE_DIR): JournalEntry[] {
  const raw = readFileSync(join(dir, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** Devuelve la lista de problemas; vacia si es seguro continuar. */
export function preflight(mode: 'generate' | 'migrate'): string[] {
  const problems: string[] = [];

  // 1. Directorio y archivos de configuracion (rutas absolutas: no dependen del cwd)
  if (!existsSync(join(API_DIR, 'drizzle.config.ts')))
    problems.push('no existe apps/api/drizzle.config.ts');
  if (!existsSync(join(DRIZZLE_DIR, 'meta', '_journal.json'))) {
    problems.push('no existe drizzle/meta/_journal.json');
    return problems;
  }

  // 2. Esquema no vacio y sin menos tablas que el ultimo snapshot (evita DROP TABLE por esquema perdido)
  const schemaFiles = existsSync(SCHEMA_DIR)
    ? readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts'))
    : [];
  if (!schemaFiles.includes('index.ts')) problems.push('falta src/db/schema/index.ts');
  const tablesInSchema = schemaFiles.reduce(
    (n, f) => n + countPgTables(readFileSync(join(SCHEMA_DIR, f), 'utf8')),
    0,
  );
  if (tablesInSchema === 0)
    problems.push('el esquema no define ninguna tabla (archivo vacio o ausente)');

  // 3. Journal coherente y con sus archivos
  const entries = readJournal();
  problems.push(...journalProblems(entries));
  for (const e of entries) {
    if (!existsSync(join(DRIZZLE_DIR, `${e.tag}.sql`))) problems.push(`falta ${e.tag}.sql`);
    if (!existsSync(join(DRIZZLE_DIR, 'meta', `${e.tag.slice(0, 4)}_snapshot.json`))) {
      problems.push(`falta el snapshot de ${e.tag}`);
    }
  }
  const last = entries.at(-1);
  if (last) {
    const snapPath = join(DRIZZLE_DIR, 'meta', `${last.tag.slice(0, 4)}_snapshot.json`);
    if (existsSync(snapPath)) {
      const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as {
        tables?: Record<string, unknown>;
      };
      const snapTables = Object.keys(snap.tables ?? {}).length;
      if (tablesInSchema < snapTables) {
        problems.push(
          `el esquema define ${tablesInSchema} tabla(s) y el ultimo snapshot ${snapTables}: generaria DROP TABLE`,
        );
      }
    }
  }

  // 4. Migraciones ya confirmadas en Git no se alteran
  if (gitOk(['rev-parse', '--verify', 'HEAD'])) {
    const committed = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'drizzle'])
      .split('\n')
      .filter(Boolean);
    for (const file of committed) {
      if (file.endsWith('_journal.json')) continue;
      if (!gitOk(['diff', '--quiet', 'HEAD', '--', file]))
        problems.push(`${file} fue modificado respecto a HEAD`);
    }
    if (committed.some((f) => f.endsWith('_journal.json'))) {
      const head = (
        JSON.parse(git(['show', 'HEAD:apps/api/drizzle/meta/_journal.json'])) as {
          entries: JournalEntry[];
        }
      ).entries;
      problems.push(...headPrefixProblems(head, entries));
    }
  }

  // 5. Operaciones destructivas en cualquier migracion existente (salvo marca manual explicita)
  for (const e of entries) {
    const sqlPath = join(DRIZZLE_DIR, `${e.tag}.sql`);
    if (!existsSync(sqlPath)) continue;
    for (const s of destructiveStatements(readFileSync(sqlPath, 'utf8'))) {
      problems.push(`${e.tag}.sql contiene una operacion destructiva: ${s}`);
    }
  }

  // 6. Para migrar: todo lo que se aplica debe estar confirmado en Git
  if (mode === 'migrate') {
    const dirty = git(['status', '--porcelain', '--', 'drizzle']).trim();
    if (dirty)
      problems.push(
        'hay cambios sin commit en apps/api/drizzle; confirma (commit) antes de migrar',
      );
  }
  return problems;
}
