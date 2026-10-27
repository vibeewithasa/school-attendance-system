import { describe, expect, it } from 'vitest';
import {
  applyPrivileges,
  checkApplyMatchesProposal,
  sha256,
  topLevelStatements,
} from '../src/db/privilege-apply.js';
import { privilegeFile } from './helpers/api-cluster.js';

/** Control de la ejecucion de la propuesta 0002: solo los cuatro GRANT aprobados, identicos y en el mismo orden. */
const proposal = privilegeFile('0002-school-catalog-write.proposal.sql');
const apply = privilegeFile('0002-school-catalog-write.apply.sql');
const verify = privilegeFile('0002-school-catalog-write.verify.sql');

describe('archivo de ejecucion 0002', () => {
  it('contiene un preflight y EXACTAMENTE los cuatro GRANT de la propuesta aprobada', () => {
    const c = checkApplyMatchesProposal(apply, proposal);
    expect(c.problems).toEqual([]);
    expect(c.grants).toHaveLength(4);
    expect(topLevelStatements(proposal)).toHaveLength(4);
    for (const g of c.grants) {
      expect(g).toMatch(/^GRANT (INSERT|UPDATE) \(/);
      expect(g).toMatch(/ ON (school_years|groups) TO eta15_api$/);
    }
    expect(topLevelStatements(apply)).toHaveLength(5); // DO + 4 GRANT
  });

  it('la propuesta conserva su barrera \\quit en la primera linea (la ejecucion no la elimina)', () => {
    expect(proposal.split('\n')[0]).toBe('\\quit');
    expect(apply).not.toMatch(/\\quit/);
  });

  it('rechaza un GRANT adicional, uno cambiado, otro destinatario, DELETE, GRANT OPTION, PUBLIC, REVOKE o DDL', () => {
    const bad = (extra: string) =>
      checkApplyMatchesProposal(`${apply}\n${extra}`, proposal).problems;
    expect(bad('GRANT DELETE ON groups TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT ON role_permissions TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT INSERT (name) ON school_years TO PUBLIC;')).not.toEqual([]);
    expect(bad('REVOKE SELECT ON groups FROM eta15_api;')).not.toEqual([]);
    expect(bad('ALTER TABLE groups OWNER TO eta15_api;')).not.toEqual([]);
    expect(bad('DROP TABLE groups;')).not.toEqual([]);
    expect(
      checkApplyMatchesProposal(apply.replace('(code, shift,', '(code, grade, shift,'), proposal)
        .problems,
    ).not.toEqual([]);
    expect(
      checkApplyMatchesProposal(apply.replace(/TO eta15_api;\n$/, 'TO eta15_app;\n'), proposal)
        .problems,
    ).not.toEqual([]);
    expect(
      checkApplyMatchesProposal(
        apply
          .replace('to eta15_api;', 'to eta15_api WITH GRANT OPTION;')
          .replace(/(UPDATE \(code[^\n]*) TO eta15_api;/, '$1 TO eta15_api WITH GRANT OPTION;'),
        proposal,
      ).problems,
    ).not.toEqual([]);
  });

  it('rechaza un preflight que modifica la base o que falta', () => {
    expect(
      checkApplyMatchesProposal(
        apply.replace('RAISE NOTICE', 'DELETE FROM groups; RAISE NOTICE'),
        proposal,
      ).problems,
    ).not.toEqual([]);
    const sinPreflight = apply.slice(apply.indexOf('GRANT INSERT'));
    expect(checkApplyMatchesProposal(sinPreflight, proposal).problems).not.toEqual([]);
  });

  it('applyPrivileges: SHA-256 distinto al revisado => no ejecuta nada', async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => void calls.push(sql) };
    await expect(
      applyPrivileges(client, {
        applySql: apply,
        verifySql: verify,
        proposalSql: proposal,
        expectedApplySha256: sha256(`${apply} `),
        commit: true,
      }),
    ).rejects.toThrow(/SHA-256/);
    expect(calls).toEqual([]);
  });

  it('applyPrivileges: en ensayo termina con ROLLBACK y en ejecucion con COMMIT; un fallo hace ROLLBACK y relanza', async () => {
    const run = async (commit: boolean, failOn?: string) => {
      const calls: string[] = [];
      const client = {
        query: async (sql: string) => {
          calls.push(sql.slice(0, 8));
          if (failOn && sql.includes(failOn)) throw new Error('falla');
        },
      };
      const p = applyPrivileges(client, {
        applySql: apply,
        verifySql: verify,
        proposalSql: proposal,
        expectedApplySha256: sha256(apply),
        commit,
      });
      return { calls, p };
    };
    const dry = await run(false);
    await dry.p;
    expect(dry.calls.at(-1)).toBe('ROLLBACK');
    const real = await run(true);
    expect((await real.p).committed).toBe(true);
    expect(real.calls[0]).toBe('BEGIN');
    expect(real.calls.at(-1)).toBe('COMMIT');
    const broken = await run(true, 'eta15_api'); // falla al ejecutar el archivo de ejecucion
    await expect(broken.p).rejects.toThrow('falla');
    expect(broken.calls.at(-1)).toBe('ROLLBACK');
    expect(broken.calls).not.toContain('COMMIT');
  });
});

describe('archivo de ejecucion 0003 (alumnos)', () => {
  const p3 = privilegeFile('0003-students-write.proposal.sql');
  const a3 = privilegeFile('0003-students-write.apply.sql');

  it('contiene un preflight y EXACTAMENTE los nueve GRANT por columna de la propuesta aprobada', () => {
    const c = checkApplyMatchesProposal(a3, p3);
    expect(c.problems).toEqual([]);
    expect(c.grants).toHaveLength(9);
    for (const g of c.grants) {
      expect(g).toMatch(/^GRANT (SELECT|INSERT|UPDATE) \(/); // todo por columna, tambien SELECT
      expect(g).toMatch(/ ON (students|enrollments|student_group_assignments) TO eta15_api$/);
    }
    expect(p3.split('\n')[0]).toBe(String.raw`\quit`);
  });

  it('rechaza cualquier GRANT adicional o ampliado', () => {
    const bad = (extra: string) => checkApplyMatchesProposal(`${a3}\n${extra}`, p3).problems;
    expect(bad('GRANT DELETE ON students TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT ON students TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT INSERT (id) ON students TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (student_id) ON enrollments TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT (id) ON students TO PUBLIC;')).not.toEqual([]);
  });
});
