import { describe, expect, it } from 'vitest';
import type { Grant, GroupAssignments } from '../src/modules/access-control/authorize.js';
import { ROLES } from '../src/modules/access-control/catalog.js';
import {
  authorizeGroupResource,
  authorizeGroupResources,
  listFilter,
  projectFields,
  queryFilter,
  type FieldSpec,
  type Principal,
} from '../src/modules/access-control/resource-authorization.js';

/**
 * CONTRATOS de autorizacion por recurso y por campo, con puertos simulados. NO hay endpoints ni tablas de
 * alumnos/asistencia/asignaciones todavia: estas pruebas fijan la regla que los futuros endpoints deben cumplir.
 */

const grantsOf = (...roleKeys: string[]): Grant[] =>
  ROLES.filter((r) => roleKeys.includes(r.key)).flatMap((r) =>
    r.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
  );
const principal = (
  userId: string,
  roles: string[],
  status: Principal['status'] = 'active',
): Principal => ({
  userId,
  status,
  grants: roles.length ? grantsOf(...roles) : [],
});

const G_1A = '0199c1a2-0000-7000-8000-00000000001a';
const G_2B = '0199c1a2-0000-7000-8000-00000000002b';
const DAY = '2026-10-26';

/** Asignaciones vigentes simuladas: la prefecta pref-1 tiene solo 1A. */
const assignments = (map: Record<string, string[]>): GroupAssignments => ({
  groupIdsFor: async (userId) => map[userId] ?? [],
});

describe('autorizacion por recurso: no se evade cambiando un UUID', () => {
  const asg = assignments({ 'pref-1': [G_1A] });
  const pref = principal('pref-1', ['prefectura']);

  it('prefecta asignada a 1A: puede 1A', async () => {
    const d = await authorizeGroupResource(pref, 'attendance:read', G_1A, DAY, asg);
    expect(d.allowed).toBe(true);
  });
  it('la misma prefecta NO puede consultar la asistencia de 2B aunque cambie el UUID en la peticion', async () => {
    expect(await authorizeGroupResource(pref, 'attendance:read', G_2B, DAY, asg)).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
    expect(await authorizeGroupResource(pref, 'attendance:capture', G_2B, DAY, asg)).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
  });
  it('un recurso inexistente o sin grupo se rechaza (el endpoint debe responder igual que fuera de alcance)', async () => {
    for (const bad of [null, undefined, '']) {
      const d = await authorizeGroupResource(pref, 'attendance:read', bad, DAY, asg);
      expect(d).toEqual({ allowed: false, reason: 'unknown_resource' });
    }
  });
  it('asignacion revocada => deniega de inmediato (la asignacion se consulta en cada peticion)', async () => {
    const revoked = assignments({ 'pref-1': [] });
    expect(await authorizeGroupResource(pref, 'attendance:read', G_1A, DAY, revoked)).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
  });
  it('rol revocado (sin grants) => sin permiso', async () => {
    const noRoles = principal('pref-1', []);
    expect(await authorizeGroupResource(noRoles, 'attendance:read', G_1A, DAY, asg)).toEqual({
      allowed: false,
      reason: 'no_permission',
    });
  });
  it('cuenta pendiente o deshabilitada => inactive, aunque tenga roles y asignaciones', async () => {
    for (const status of ['pending', 'disabled'] as const) {
      const p = principal('pref-1', ['prefectura'], status);
      expect(await authorizeGroupResource(p, 'attendance:read', G_1A, DAY, asg)).toEqual({
        allowed: false,
        reason: 'inactive',
      });
    }
  });
  it('permiso funcional ausente: control_acceso no lee asistencia de ningun grupo', async () => {
    const c = principal('c-1', ['control_acceso']);
    expect(await authorizeGroupResource(c, 'attendance:read', G_1A, DAY, asg)).toEqual({
      allowed: false,
      reason: 'no_permission',
    });
  });
  it('admin_tecnico es denegado en todo recurso escolar', async () => {
    const t = principal('t-1', ['admin_tecnico']);
    for (const perm of [
      'students:read',
      'attendance:read',
      'attendance:capture',
      'justifications:read',
    ]) {
      expect((await authorizeGroupResource(t, perm, G_1A, DAY, asg)).allowed, perm).toBe(false);
    }
  });
  it('trabajo_social y direccion (scope all) acceden a cualquier grupo', async () => {
    for (const role of ['trabajo_social', 'direccion']) {
      expect(
        (await authorizeGroupResource(principal('x', [role]), 'attendance:read', G_2B, DAY, asg))
          .allowed,
        role,
      ).toBe(true);
    }
  });
  it('un permiso con scope own no autoriza recursos de grupo', async () => {
    const p: Principal = {
      userId: 'u',
      status: 'active',
      grants: [{ permission: 'x:y', scope: 'own' }],
    };
    expect(await authorizeGroupResource(p, 'x:y', G_1A, DAY, asg)).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
  });
  it('operaciones en lote: un solo grupo fuera de alcance rechaza todo el lote', async () => {
    expect(
      (await authorizeGroupResources(pref, 'attendance:capture', [G_1A, G_1A], DAY, asg)).allowed,
    ).toBe(true);
    expect(
      await authorizeGroupResources(pref, 'attendance:capture', [G_1A, G_2B], DAY, asg),
    ).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
    expect((await authorizeGroupResources(pref, 'attendance:capture', [], DAY, asg)).allowed).toBe(
      false,
    );
  });
});

describe('listados: el alcance se aplica en la consulta', () => {
  const asg = assignments({ 'pref-1': [G_2B, G_1A] });

  it('prefecta => filtro por sus grupos (ordenados), nunca "todos"', async () => {
    expect(
      await listFilter(principal('pref-1', ['prefectura']), 'attendance:read', DAY, asg),
    ).toEqual({
      type: 'groups',
      groupIds: [G_1A, G_2B],
    });
  });
  it('prefecta SIN asignaciones => none (cero filas), no "sin filtro"', async () => {
    expect(
      await listFilter(principal('pref-9', ['prefectura']), 'attendance:read', DAY, asg),
    ).toEqual({ type: 'none' });
  });
  it('scope all => all; sin permiso => none; cuenta inactiva => none', async () => {
    expect(await listFilter(principal('d', ['direccion']), 'attendance:read', DAY, asg)).toEqual({
      type: 'all',
    });
    expect(
      await listFilter(principal('c', ['control_acceso']), 'attendance:read', DAY, asg),
    ).toEqual({ type: 'none' });
    expect(
      await listFilter(
        principal('pref-1', ['prefectura'], 'disabled'),
        'attendance:read',
        DAY,
        asg,
      ),
    ).toEqual({ type: 'none' });
  });
  it('queryFilter traduce cada Access', () => {
    expect(queryFilter({ kind: 'denied' })).toEqual({ type: 'none' });
    expect(queryFilter({ kind: 'all' })).toEqual({ type: 'all' });
    expect(queryFilter({ kind: 'groups', groupIds: new Set() })).toEqual({ type: 'none' });
    expect(queryFilter({ kind: 'own', userId: 'u1' })).toEqual({ type: 'own', userId: 'u1' });
  });
});

describe('autorizacion por campo sensible', () => {
  const student = {
    id: 'a1',
    fullName: 'Alumno de prueba',
    group: '1A',
    curp: 'DATO-FICTICIO',
    medicalNotes: 'dato ficticio',
  };
  const spec: FieldSpec = {
    id: 'students:read_basic',
    fullName: 'students:read_basic',
    group: 'students:read_basic',
    curp: 'students:read',
    medicalNotes: 'students:read',
  };

  it('control_acceso solo ve datos basicos', () => {
    expect(projectFields(student, spec, principal('c', ['control_acceso']))).toEqual({
      id: 'a1',
      fullName: 'Alumno de prueba',
      group: '1A',
    });
  });
  it('trabajo_social y prefectura (con el expediente) ven los campos protegidos', () => {
    expect(Object.keys(projectFields(student, spec, principal('t', ['trabajo_social'])))).toContain(
      'curp',
    );
    expect(Object.keys(projectFields(student, spec, principal('p', ['prefectura'])))).toContain(
      'medicalNotes',
    );
  });
  it('admin_tecnico no ve ningun campo; un campo sin regla nunca se devuelve', () => {
    expect(projectFields(student, spec, principal('a', ['admin_tecnico']))).toEqual({});
    expect(
      projectFields({ ...student, nuevoCampo: 'x' }, spec, principal('d', ['direccion'])),
    ).not.toHaveProperty('nuevoCampo');
  });
  it('cuenta inactiva => ningun campo', () => {
    expect(projectFields(student, spec, principal('d', ['direccion'], 'disabled'))).toEqual({});
  });
});
