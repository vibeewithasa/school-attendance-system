import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  IDENTITY_SQL,
  ownerIdentityProblems,
  runtimeIdentityProblems,
  type IdentityRow,
} from '../src/db/identity.js';
import { checkRuntimeRole } from '../src/db/runtime-guard.js';

const api: IdentityRow = {
  usuario: 'eta15_api',
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false,
  es_dueno_bd: false,
  crea_en_public: false,
  crea_esquemas: false,
  crea_temporales: false,
};
const owner: IdentityRow = {
  ...api,
  usuario: 'eta15_app',
  es_dueno_bd: true,
  crea_en_public: true,
  crea_esquemas: true,
  crea_temporales: true,
};

describe('identidad de la conexion', () => {
  it('eta15_api con minimo privilegio es correcto', () => {
    expect(runtimeIdentityProblems(api)).toEqual([]);
  });
  it('el propietario/migrador NO es un rol de ejecucion valido', () => {
    const problems = runtimeIdentityProblems(owner);
    expect(problems.join(' | ')).toMatch(/debe ser eta15_api/);
    expect(problems.join(' | ')).toMatch(/propietario/);
    expect(problems.join(' | ')).toMatch(/crear objetos en el esquema public/);
  });
  it.each([
    ['rolsuper', 'superusuario'],
    ['rolcreaterole', 'crear roles'],
    ['rolcreatedb', 'crear bases'],
    ['rolreplication', 'REPLICATION'],
    ['rolbypassrls', 'seguridad por filas'],
    ['es_dueno_bd', 'propietario'],
    ['crea_en_public', 'esquema public'],
    ['crea_esquemas', 'crear esquemas'],
    ['crea_temporales', 'temporales'],
  ] as const)('cada privilegio indebido (%s) se detecta', (flag, text) => {
    expect(runtimeIdentityProblems({ ...api, [flag]: true }).join(' ')).toContain(text);
  });
  it('un rol distinto de eta15_api tampoco es el rol de la API', () => {
    expect(runtimeIdentityProblems({ ...api, usuario: 'otro' })[0]).toMatch(/debe ser eta15_api/);
  });
  it('el migrador debe ser el propietario y nunca eta15_api', () => {
    expect(ownerIdentityProblems(owner)).toEqual([]);
    expect(ownerIdentityProblems(api).join(' ')).toMatch(/no pueden usar eta15_api/);
    expect(ownerIdentityProblems({ ...owner, es_dueno_bd: false }).join(' ')).toMatch(
      /no es propietario/,
    );
  });
  it('la consulta solo lee catalogos (sin escritura)', () => {
    // Se ignoran los literales entre comillas: 'CREATE' es un argumento de has_schema_privilege, no una sentencia.
    const sinLiterales = IDENTITY_SQL.replace(/'[^']*'/g, '').toLowerCase();
    expect(sinLiterales).not.toMatch(/\b(insert|update|delete|create|drop|alter|truncate)\b/);
  });
});

describe('checkRuntimeRole (arranque de la API)', () => {
  const db = (fn: () => Promise<string[]>): Database => ({
    ping: async () => undefined,
    close: async () => undefined,
    verifyRuntimeIdentity: fn,
  });
  it('ok cuando no hay problemas', async () => {
    expect(await checkRuntimeRole(db(async () => []))).toEqual({ status: 'ok' });
  });
  it('privileged cuando el rol es del migrador', async () => {
    const r = await checkRuntimeRole(db(async () => ['es propietario']));
    expect(r).toEqual({ status: 'privileged', problems: ['es propietario'] });
  });
  it('unreachable (no fatal) cuando la base no responde', async () => {
    expect(
      await checkRuntimeRole(db(async () => Promise.reject(new Error('ECONNREFUSED')))),
    ).toEqual({ status: 'unreachable' });
  });
  it('sin verificacion disponible no bloquea (dobles de prueba)', async () => {
    expect(
      await checkRuntimeRole({ ping: async () => undefined, close: async () => undefined }),
    ).toEqual({ status: 'ok' });
  });
});
