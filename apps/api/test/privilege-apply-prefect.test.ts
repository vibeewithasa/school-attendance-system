import { describe, expect, it } from 'vitest';
import { checkApplyMatchesProposal } from '../src/db/privilege-apply.js';
import { privilegeFile } from './helpers/api-cluster.js';

describe('archivo de ejecucion 0004 (asignaciones de prefectura)', () => {
  const p4 = privilegeFile('0004-prefect-assignments-write.proposal.sql');
  const a4 = privilegeFile('0004-prefect-assignments-write.apply.sql');

  it('contiene un preflight y EXACTAMENTE los tres GRANT por columna de la propuesta aprobada', () => {
    const c = checkApplyMatchesProposal(a4, p4);
    expect(c.problems).toEqual([]);
    expect(c.grants).toHaveLength(3);
    for (const g of c.grants) {
      expect(g).toMatch(/^GRANT (SELECT|INSERT|UPDATE) \(/); // todo por columna, tambien SELECT
      expect(g).toMatch(/ ON prefect_group_assignments TO eta15_api$/);
    }
    expect(p4.split('\n')[0]).toBe(String.raw`\quit`);
  });

  it('rechaza cualquier GRANT adicional o ampliado', () => {
    const bad = (extra: string) => checkApplyMatchesProposal(`${a4}\n${extra}`, p4).problems;
    expect(bad('GRANT DELETE ON prefect_group_assignments TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT ON prefect_group_assignments TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (revoked_at) ON prefect_group_assignments TO eta15_api;')).not.toEqual(
      [],
    );
    expect(bad('GRANT SELECT (id) ON prefect_group_assignments TO PUBLIC;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (ends_on) ON role_permissions TO eta15_api;')).not.toEqual([]);
  });
});
