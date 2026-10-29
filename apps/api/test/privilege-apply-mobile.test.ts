import { describe, expect, it } from 'vitest';
import { checkApplyMatchesProposal } from '../src/db/privilege-apply.js';
import { privilegeFile } from './helpers/api-cluster.js';

describe('archivo de ejecucion 0006 (autenticacion movil aislada)', () => {
  const p6 = privilegeFile('0006-mobile-auth-write.proposal.sql');
  const a6 = privilegeFile('0006-mobile-auth-write.apply.sql');

  it('contiene un preflight y EXACTAMENTE los dieciseis GRANT de la propuesta (catorce por columna y dos EXECUTE)', () => {
    const c = checkApplyMatchesProposal(a6, p6);
    expect(c.problems).toEqual([]);
    expect(c.grants).toHaveLength(16);
    const tables = c.grants.filter((g) => !g.startsWith('GRANT EXECUTE'));
    expect(tables).toHaveLength(14);
    for (const g of tables) {
      expect(g).toMatch(/^GRANT (SELECT|INSERT|UPDATE) \(/); // todo por columna, tambien SELECT
      expect(g).toMatch(
        / ON mobile_(device_requests|devices|sessions|proof_jtis|nonces) TO eta15_api$/,
      );
    }
    expect(p6.split('\n')[0]).toBe(String.raw`\quit`);
  });

  it('las horas, la identidad y la clave publica nunca se conceden para escribir donde el trigger o la identidad mandan', () => {
    const grants = checkApplyMatchesProposal(a6, p6).grants;
    const cols = (verb: string, table: string) => {
      const g = grants.find(
        (x) => x.startsWith(`GRANT ${verb} (`) && x.endsWith(` ON ${table} TO eta15_api`),
      )!;
      return g.slice(g.indexOf('(') + 1, g.indexOf(')')).split(/,\s*/);
    };
    for (const t of ['mobile_device_requests', 'mobile_devices', 'mobile_sessions']) {
      for (const forbidden of ['id', 'updated_at'])
        expect(cols('INSERT', t), `${t} INSERT ${forbidden}`).not.toContain(forbidden);
      // en ningun UPDATE: identidad, huella, clave publica, hash del codigo, ni las horas fijadas por trigger
      for (const forbidden of [
        'id',
        'key_thumbprint',
        'public_key_jwk',
        'pairing_code_hash',
        'device_label',
        'label',
        'request_id',
        'created_at',
        'expires_at',
        'absolute_expires_at',
        'device_id',
        'registered_at',
        'claimed_at',
        'approved_at',
        'activated_at',
        'closed_at',
        'revoked_at',
        'last_refreshed_at',
        'ip',
        'user_agent',
        'requested_ip',
        'platform',
      ])
        expect(cols('UPDATE', t), `${t} UPDATE ${forbidden}`).not.toContain(forbidden);
    }
    // el estado de una solicitud y de un dispositivo nace por DEFAULT y la hora de alta la fija la base
    expect(cols('INSERT', 'mobile_device_requests')).not.toContain('status');
    expect(cols('INSERT', 'mobile_device_requests')).not.toContain('user_id');
    expect(cols('INSERT', 'mobile_device_requests')).not.toContain('approved_by');
    expect(cols('INSERT', 'mobile_devices')).not.toContain('status');
    expect(cols('INSERT', 'mobile_devices')).not.toContain('registered_at');
    expect(cols('INSERT', 'mobile_sessions')).not.toContain('refresh_count');
    expect(cols('INSERT', 'mobile_sessions')).not.toContain('revoked_reason');
  });

  it('solo concede EXECUTE sobre las dos funciones de elegibilidad y ninguna de trigger', () => {
    const exec = checkApplyMatchesProposal(a6, p6).grants.filter((g) =>
      g.startsWith('GRANT EXECUTE'),
    );
    expect(exec).toEqual([
      'GRANT EXECUTE ON FUNCTION mobile_user_eligible(uuid, timestamp with time zone) TO eta15_api',
      'GRANT EXECUTE ON FUNCTION mobile_actor_can_manage(uuid) TO eta15_api',
    ]);
  });

  it('rechaza cualquier GRANT adicional o ampliado', () => {
    const bad = (extra: string) => checkApplyMatchesProposal(`${a6}\n${extra}`, p6).problems;
    expect(bad('GRANT DELETE ON mobile_sessions TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT ON mobile_devices TO eta15_api;')).not.toEqual([]); // tabla completa: no esta en la propuesta
    expect(bad('GRANT UPDATE (public_key_jwk) ON mobile_devices TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (approved_at) ON mobile_device_requests TO eta15_api;')).not.toEqual(
      [],
    );
    expect(bad('GRANT SELECT (id) ON mobile_devices TO PUBLIC;')).not.toEqual([]);
    expect(bad('GRANT INSERT (permission_id) ON role_permissions TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT EXECUTE ON FUNCTION md_guard_update() TO eta15_api;')).not.toEqual([]);
  });
});

describe('archivo de ejecucion 0006: estado efimero de seguridad (pruebas DPoP y nonces)', () => {
  const p6 = privilegeFile('0006-mobile-auth-write.proposal.sql');
  const a6 = privilegeFile('0006-mobile-auth-write.apply.sql');
  const grants = checkApplyMatchesProposal(a6, p6).grants;
  const cols = (verb: string, table: string) => {
    const g = grants.find(
      (x) => x.startsWith(`GRANT ${verb} (`) && x.endsWith(` ON ${table} TO eta15_api`),
    );
    return g ? g.slice(g.indexOf('(') + 1, g.indexOf(')')).split(/,\s*/) : null;
  };

  it('las pruebas aceptadas: solo se cuentan (clave + vigencia) y se insertan; nunca se actualizan ni se lee el hash del jti', () => {
    expect(cols('SELECT', 'mobile_proof_jtis')).toEqual(['key_thumbprint', 'expires_at']);
    expect(cols('INSERT', 'mobile_proof_jtis')).toEqual([
      'key_thumbprint',
      'jti_hash',
      'seen_at',
      'expires_at',
    ]);
    expect(cols('UPDATE', 'mobile_proof_jtis')).toBeNull();
  });

  it('los nonces: se insertan, se leen lo justo y de ellos solo se actualiza consumed_at', () => {
    expect(cols('SELECT', 'mobile_nonces')).toEqual([
      'nonce_hash',
      'key_thumbprint',
      'expires_at',
      'consumed_at',
    ]);
    expect(cols('INSERT', 'mobile_nonces')).toEqual([
      'nonce_hash',
      'key_thumbprint',
      'issued_at',
      'expires_at',
    ]);
    expect(cols('UPDATE', 'mobile_nonces')).toEqual(['consumed_at']);
  });

  it('rechaza DELETE, TRUNCATE o UPDATE ampliado sobre el estado efimero', () => {
    const bad = (extra: string) => checkApplyMatchesProposal(`${a6}\n${extra}`, p6).problems;
    expect(bad('GRANT DELETE ON mobile_proof_jtis TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT DELETE ON mobile_nonces TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (expires_at) ON mobile_proof_jtis TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT UPDATE (expires_at) ON mobile_nonces TO eta15_api;')).not.toEqual([]);
    expect(bad('GRANT SELECT (jti_hash) ON mobile_proof_jtis TO eta15_api;')).not.toEqual([]);
  });
});
