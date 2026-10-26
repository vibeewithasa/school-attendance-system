import { describe, expect, it } from 'vitest';
import {
  ALLOW_DESTRUCTIVE_MARKER,
  countPgTables,
  destructiveStatements,
  headPrefixProblems,
  journalProblems,
  preflight,
  type JournalEntry,
} from '../scripts/drizzle-guard.js';

const e = (idx: number, tag: string, when: number): JournalEntry => ({ idx, tag, when });

describe('destructiveStatements', () => {
  it.each([
    'DROP TABLE "groups" CASCADE;',
    'ALTER TABLE "groups" DROP COLUMN "shift";',
    'TRUNCATE "groups";',
    'DELETE FROM groups;',
    'ALTER TABLE "groups" ALTER COLUMN "grade" SET DATA TYPE integer;',
    'ALTER TABLE "groups" RENAME COLUMN "code" TO "label";',
    'drop table groups',
  ])('detecta %s', (sql) => {
    expect(destructiveStatements(sql).length).toBeGreaterThan(0);
  });

  it('no marca migraciones incrementales seguras', () => {
    const sql = `ALTER TABLE "groups" ADD COLUMN "expected_entry_time" time(0);--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "c" CHECK ("x" < TIME '24:00:00');
CREATE TRIGGER t BEFORE UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION f();`;
    expect(destructiveStatements(sql)).toEqual([]);
  });

  it('TRUNCATE como evento de trigger no es una operacion destructiva, pero la sentencia si', () => {
    expect(
      destructiveStatements(
        'CREATE TRIGGER t BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION f();',
      ),
    ).toEqual([]);
    expect(destructiveStatements('TRUNCATE "groups";').length).toBeGreaterThan(0);
    expect(destructiveStatements('BEGIN TRUNCATE x; END').length).toBeGreaterThan(0);
  });

  it('ignora comentarios y respeta la marca manual explicita', () => {
    expect(destructiveStatements('-- DROP TABLE x\nSELECT 1;')).toEqual([]);
    expect(destructiveStatements(`${ALLOW_DESTRUCTIVE_MARKER}\nDROP TABLE x;`)).toEqual([]);
  });
});

describe('journalProblems', () => {
  it('acepta un journal ordenado', () => {
    expect(journalProblems([e(0, '0000_a', 1), e(1, '0001_b', 2)])).toEqual([]);
  });
  it('detecta indices fuera de orden, etiquetas que no corresponden y marcas no crecientes', () => {
    expect(journalProblems([e(1, '0001_a', 1)])).not.toEqual([]);
    expect(journalProblems([e(0, '0001_a', 1)])).not.toEqual([]);
    expect(journalProblems([e(0, '0000_a', 5), e(1, '0001_b', 5)])).not.toEqual([]);
  });
});

describe('headPrefixProblems', () => {
  const head = [e(0, '0000_a', 1), e(1, '0001_b', 2)];
  it('permite agregar migraciones nuevas al final', () => {
    expect(headPrefixProblems(head, [...head, e(2, '0002_c', 3)])).toEqual([]);
  });
  it('rechaza quitar o reescribir una migracion confirmada', () => {
    expect(headPrefixProblems(head, [head[0]!])).not.toEqual([]);
    expect(headPrefixProblems(head, [head[0]!, e(1, '0001_b', 99)])).not.toEqual([]);
  });
});

describe('countPgTables', () => {
  it('cuenta tablas y devuelve 0 para un archivo vacio', () => {
    expect(countPgTables('')).toBe(0);
    expect(
      countPgTables("export const a = pgTable('a', {});\nexport const b = pgTable(\n'b', {});"),
    ).toBe(2);
  });
});

describe('preflight sobre el repositorio real', () => {
  it('el estado actual del repositorio pasa las verificaciones de generacion', () => {
    expect(preflight('generate')).toEqual([]);
  });
});
