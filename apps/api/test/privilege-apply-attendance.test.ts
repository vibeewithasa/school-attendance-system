import { describe, expect, it } from 'vitest';
import { checkApplyMatchesProposal } from '../src/db/privilege-apply.js';
import { privilegeFile } from './helpers/api-cluster.js';

describe('archivo de ejecucion 0005 (asistencia diaria)', () => {
  const p5 = privilegeFile('0005-attendance-write.proposal.sql');
  const a5 = privilegeFile('0005-attendance-write.apply.sql');

  it('contiene un preflight y EXACTAMENTE los ocho GRANT por columna de la propuesta aprobada', () => {
    const c = checkApplyMatchesProposal(a5, p5);
    expect(c.problems).toEqual([]);
    expect(c.grants).toHaveLength(8);
    for (const g of c.grants) {
      expect(g).toMatch(/^GRANT (SELECT|INSERT|UPDATE) \(/); // todo por columna, tambien SELECT
      expect(g).toMatch(/ ON attendance_(days|records|events) TO eta15_api$/);
    }
    expect(p5.split('\n')[0]).toBe(String.raw`\quit`);
  });

  it('el historial (attendance_events) no recibe ningun UPDATE ni DELETE en la propuesta', () => {
    const events = checkApplyMatchesProposal(a5, p5).grants.filter((g) =>
      g.includes('attendance_events'),
    );
    expect(events).toHaveLength(2);
    expect(events.map((g) => g.split(' ')[1])).toEqual(['SELECT', 'INSERT']);
    // ninguna columna de identidad, de hora ni de estado inicial en los INSERT de las tres tablas
    const inserts = checkApplyMatchesProposal(a5, p5).grants.filter((x) =>
      x.startsWith('GRANT INSERT'),
    );
    expect(inserts).toHaveLength(3);
    for (const g of inserts) {
      const cols = g.slice(g.indexOf('(') + 1, g.indexOf(')')).split(/,\s*/);
      for (const forbidden of [
        'id',
        'occurred_at',
        'created_at',
        'updated_at',
        'marked_at',
        'finalized_at',
        'finalized_by',
        'revision',
        'status',
        'marked_by',
      ])
        expect(cols, g).not.toContain(forbidden);
    }
  });

  it('rechaza cualquier GRANT adicional o ampliado', () => {
    const bad = (extra: string) => checkApplyMatchesProposal(`${a5}\n${extra}`, p5).problems;
    expect(bad('GRANT DELETE ON attendance_days TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT ON attendance_records TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (revision_after) ON attendance_events TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (finalized_at) ON attendance_days TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT (id) ON attendance_days TO PUBLIC;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (scope) ON role_permissions TO eta15_api;')).not.toEqual([]);
  });
});
