import { describe, expect, it } from 'vitest';
import { checkApplyMatchesProposal } from '../src/db/privilege-apply.js';
import { privilegeFile } from './helpers/api-cluster.js';

describe('archivo de ejecucion 0007 (recepcion de justificantes)', () => {
  const p7 = privilegeFile('0007-justifications-write.proposal.sql');
  const a7 = privilegeFile('0007-justifications-write.apply.sql');

  it('contiene un preflight y EXACTAMENTE dos GRANT por columna: SELECT e INSERT', () => {
    const c = checkApplyMatchesProposal(a7, p7);
    expect(c.problems).toEqual([]);
    expect(c.grants).toHaveLength(2);
    expect(c.grants.map((g) => g.split(' ')[1])).toEqual(['SELECT', 'INSERT']);
    for (const g of c.grants) {
      expect(g).toMatch(/^GRANT (SELECT|INSERT) \(/); // todo por columna, tambien SELECT
      expect(g).toMatch(/ ON justification_receipts TO eta15_api$/);
    }
    expect(p7.split('\n')[0]).toBe(String.raw`\quit`);
  });

  it('el INSERT no incluye identidad, folio, hora ni estado: los fija la base', () => {
    const insert = checkApplyMatchesProposal(a7, p7).grants.find((g) =>
      g.startsWith('GRANT INSERT'),
    )!;
    const cols = insert.slice(insert.indexOf('(') + 1, insert.indexOf(')')).split(/,\s*/);
    expect([...cols].sort()).toEqual(
      [
        'payload_hash',
        'received_by',
        'request_id',
        'school_date',
        'school_year_id',
        'student_id',
      ].sort(),
    );
    for (const forbidden of ['id', 'folio', 'folio_number', 'received_at', 'status'])
      expect(cols).not.toContain(forbidden);
  });

  it('rechaza cualquier GRANT adicional o ampliado (UPDATE, DELETE, PUBLIC, autorizacion)', () => {
    const bad = (extra: string) => checkApplyMatchesProposal(`${a7}\n${extra}`, p7).problems;
    expect(bad('GRANT UPDATE (status) ON justification_receipts TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT DELETE ON justification_receipts TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT INSERT (received_at) ON justification_receipts TO eta15_api;')).not.toEqual(
      [],
    );
    expect(bad('GRANT SELECT (id) ON justification_receipts TO PUBLIC;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (scope) ON role_permissions TO eta15_api;')).not.toEqual([]);
  });
});
