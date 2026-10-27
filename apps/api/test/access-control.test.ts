import { describe, expect, it } from 'vitest';
import { allowsGroup, resolveAccess, type Grant } from '../src/modules/access-control/authorize.js';
import { PERMISSIONS, ROLES, type RoleDomain } from '../src/modules/access-control/catalog.js';
import {
  canEditRolePermission,
  canGrantRole,
  canManageAccount,
  canRevokeRole,
  type Actor,
  type TargetAccount,
} from '../src/modules/access-control/grant-policy.js';

/** Pruebas unitarias de la logica pura de autorizacion (sin base de datos). */

function grantsOf(...roleKeys: string[]): Grant[] {
  return ROLES.filter((r) => roleKeys.includes(r.key)).flatMap((r) =>
    r.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
  );
}
function actorOf(id: string, roleKeys: string[], status: Actor['status'] = 'active'): Actor {
  return {
    id,
    status,
    roleKeys: new Set(roleKeys),
    permissions: new Set(grantsOf(...roleKeys).map((g) => g.permission)),
  };
}
const target = (
  id: string,
  accountDomain: RoleDomain,
  status: TargetAccount['status'] = 'active',
): TargetAccount => ({
  id,
  accountDomain,
  status,
});
const roleDef = (key: string) => {
  const r = ROLES.find((x) => x.key === key)!;
  return { key: r.key, domain: r.domain };
};
const perm = (key: string) => {
  const p = PERMISSIONS.find((x) => x.key === key)!;
  return { key: p.key, domain: p.domain };
};

describe('resolveAccess: denegar por defecto y alcance', () => {
  const none = { groupIdsFor: async () => [] as string[] };
  const assigned = { groupIdsFor: async (u: string) => (u === 'pref-1' ? ['g1', 'g2'] : []) };

  it('sin el permiso => denegado', async () => {
    expect(
      await resolveAccess(grantsOf('control_acceso'), 'attendance:read', 'u', '2026-10-26', none),
    ).toEqual({ kind: 'denied' });
    expect(await resolveAccess([], 'catalog:read', 'u', '2026-10-26', none)).toEqual({
      kind: 'denied',
    });
  });
  it('un permiso desconocido => denegado', async () => {
    expect(
      await resolveAccess(grantsOf('direccion'), 'nada:inventado', 'u', '2026-10-26', none),
    ).toEqual({ kind: 'denied' });
  });
  it('admin_tecnico es denegado en todos los permisos escolares', async () => {
    const grants = grantsOf('admin_tecnico');
    for (const p of PERMISSIONS.filter((x) => x.domain === 'school')) {
      expect((await resolveAccess(grants, p.key, 'a', '2026-10-26', none)).kind, p.key).toBe(
        'denied',
      );
    }
  });
  it('prefectura accede solo a los grupos con asignacion vigente', async () => {
    const access = await resolveAccess(
      grantsOf('prefectura'),
      'attendance:capture',
      'pref-1',
      '2026-10-26',
      assigned,
    );
    expect(access.kind).toBe('groups');
    expect(allowsGroup(access, 'g1')).toBe(true);
    expect(allowsGroup(access, 'g3')).toBe(false);
  });
  it('prefectura sin asignaciones => conjunto vacio (no error, no acceso)', async () => {
    const access = await resolveAccess(
      grantsOf('prefectura'),
      'attendance:capture',
      'pref-2',
      '2026-10-26',
      assigned,
    );
    expect(access).toEqual({ kind: 'groups', groupIds: new Set() });
    expect(allowsGroup(access, 'g1')).toBe(false);
  });
  it('si algun rol concede all, domina sobre assigned_groups', async () => {
    const access = await resolveAccess(
      grantsOf('prefectura', 'trabajo_social'),
      'justifications:read',
      'pref-1',
      '2026-10-26',
      assigned,
    );
    expect(access).toEqual({ kind: 'all' });
  });
  it('alcance own', async () => {
    const access = await resolveAccess(
      [{ permission: 'x:y', scope: 'own' }],
      'x:y',
      'u1',
      '2026-10-26',
      none,
    );
    expect(access).toEqual({ kind: 'own', userId: 'u1' });
    expect(allowsGroup(access, 'g1')).toBe(false);
  });
});

describe('escalamiento: conceder y revocar roles', () => {
  const tech = actorOf('t1', ['admin_tecnico']);
  const dir = actorOf('d1', ['direccion']);
  const pref = actorOf('p1', ['prefectura']);

  it('autoasignacion denegada para cualquier rol y actor', () => {
    expect(canGrantRole(tech, target('t1', 'technical'), roleDef('admin_tecnico')).allowed).toBe(
      false,
    );
    expect(canGrantRole(dir, target('d1', 'school'), roleDef('direccion')).allowed).toBe(false);
    expect(canGrantRole(dir, target('d1', 'school'), roleDef('trabajo_social')).allowed).toBe(
      false,
    );
  });
  it('admin_tecnico no puede conceder NINGUN rol escolar', () => {
    for (const key of ['direccion', 'prefectura', 'trabajo_social', 'control_acceso']) {
      const d = canGrantRole(tech, target('x', 'school'), roleDef(key));
      expect(d.allowed, key).toBe(false);
    }
  });
  it('direccion no puede conceder admin_tecnico', () => {
    expect(canGrantRole(dir, target('x', 'technical'), roleDef('admin_tecnico')).allowed).toBe(
      false,
    );
  });
  it('direccion concede roles escolares a otra cuenta escolar; admin_tecnico a otra cuenta tecnica', () => {
    expect(canGrantRole(dir, target('x', 'school'), roleDef('prefectura'))).toEqual({
      allowed: true,
    });
    expect(canGrantRole(tech, target('x', 'technical'), roleDef('admin_tecnico'))).toEqual({
      allowed: true,
    });
  });
  it('el dominio del rol debe coincidir con el de la cuenta', () => {
    const d = canGrantRole(dir, target('x', 'technical'), roleDef('prefectura'));
    expect(d).toEqual({ allowed: false, reason: expect.stringContaining('dominio') });
  });
  it('un rol sin roles:grant_* no concede nada', () => {
    expect(canGrantRole(pref, target('x', 'school'), roleDef('prefectura')).allowed).toBe(false);
  });
  it('actor deshabilitado o pendiente => denegado; cuenta destino deshabilitada => denegado', () => {
    expect(
      canGrantRole(
        actorOf('d2', ['direccion'], 'disabled'),
        target('x', 'school'),
        roleDef('prefectura'),
      ).allowed,
    ).toBe(false);
    expect(
      canGrantRole(
        actorOf('d3', ['direccion'], 'pending'),
        target('x', 'school'),
        roleDef('prefectura'),
      ).allowed,
    ).toBe(false);
    expect(
      canGrantRole(dir, target('x', 'school', 'disabled'), roleDef('prefectura')).allowed,
    ).toBe(false);
  });
  it('revocar: renunciar a un rol propio se permite; revocar a otro exige el permiso', () => {
    expect(canRevokeRole(pref, target('p1', 'school'), roleDef('prefectura'))).toEqual({
      allowed: true,
    });
    expect(canRevokeRole(tech, target('d1', 'school'), roleDef('direccion')).allowed).toBe(false);
    expect(canRevokeRole(dir, target('p1', 'school'), roleDef('prefectura'))).toEqual({
      allowed: true,
    });
  });
});

describe('escalamiento: gestion de cuentas', () => {
  const tech = actorOf('t1', ['admin_tecnico']);
  const dir = actorOf('d1', ['direccion']);

  it('cada dominio administra sus propias cuentas', () => {
    expect(canManageAccount(tech, target('t2', 'technical'), 'create').allowed).toBe(true);
    expect(canManageAccount(dir, target('p1', 'school'), 'issue_invite').allowed).toBe(true);
  });
  it('admin_tecnico no crea, invita, recupera ni reactiva cuentas escolares (tomaria su control)', () => {
    for (const action of [
      'create',
      'update',
      'issue_invite',
      'reset_credentials',
      'enable',
    ] as const) {
      expect(canManageAccount(tech, target('d1', 'school'), action).allowed, action).toBe(false);
    }
  });
  it('direccion no gestiona cuentas tecnicas', () => {
    expect(canManageAccount(dir, target('t1', 'technical'), 'reset_credentials').allowed).toBe(
      false,
    );
  });
  it('admin_tecnico SI puede deshabilitar y cerrar sesiones de cualquier cuenta (solo reduce acceso)', () => {
    expect(canManageAccount(tech, target('d1', 'school'), 'disable').allowed).toBe(true);
    expect(canManageAccount(tech, target('d1', 'school'), 'revoke_sessions').allowed).toBe(true);
  });
  it('nadie se deshabilita a si mismo por la via de soporte ni se restablece su propia credencial', () => {
    expect(canManageAccount(tech, target('t1', 'school'), 'disable').allowed).toBe(false);
    expect(canManageAccount(dir, target('d1', 'school'), 'reset_credentials').allowed).toBe(false);
  });
});

describe('escalamiento: edicion de permisos de roles', () => {
  const tech = actorOf('t1', ['admin_tecnico']);
  const dir = actorOf('d1', ['direccion']);

  it('admin_tecnico no puede modificar roles escolares', () => {
    expect(
      canEditRolePermission(tech, roleDef('prefectura'), perm('students:read'), 'add').allowed,
    ).toBe(false);
    expect(
      canEditRolePermission(tech, roleDef('direccion'), perm('students:read'), 'add').allowed,
    ).toBe(false);
  });
  it('direccion puede ampliar otro rol escolar, pero no el suyo, y puede reducir el suyo', () => {
    expect(
      canEditRolePermission(dir, roleDef('control_acceso'), perm('students:read'), 'add'),
    ).toEqual({ allowed: true });
    expect(
      canEditRolePermission(dir, roleDef('direccion'), perm('attendance:capture'), 'add').allowed,
    ).toBe(false);
    expect(
      canEditRolePermission(dir, roleDef('direccion'), perm('reports:read'), 'remove'),
    ).toEqual({ allowed: true });
  });
  it('no se agregan permisos de otro dominio a un rol', () => {
    expect(
      canEditRolePermission(dir, roleDef('control_acceso'), perm('audit:read'), 'add').allowed,
    ).toBe(false);
    expect(
      canEditRolePermission(tech, roleDef('admin_tecnico'), perm('students:read'), 'add').allowed,
    ).toBe(false);
  });
  it('los permisos de autoridad no se editan desde la API ni por quien tiene roles:manage_*', () => {
    const authority = (key: string) => {
      const p = PERMISSIONS.find((x) => x.key === key)!;
      return { key: p.key, domain: p.domain, authority: p.authority };
    };
    for (const change of ['add', 'remove'] as const) {
      expect(
        canEditRolePermission(
          dir,
          roleDef('control_acceso'),
          authority('roles:grant_school'),
          change,
        ).allowed,
      ).toBe(false);
      expect(
        canEditRolePermission(dir, roleDef('prefectura'), authority('users:manage_school'), change)
          .allowed,
      ).toBe(false);
      expect(
        canEditRolePermission(
          tech,
          roleDef('admin_tecnico'),
          authority('roles:grant_technical'),
          change,
        ).allowed,
      ).toBe(false);
    }
  });
  it('un administrador tecnico no amplia su propio rol, pero si otros roles tecnicos', () => {
    expect(
      canEditRolePermission(tech, roleDef('admin_tecnico'), perm('system:config'), 'add').allowed,
    ).toBe(false);
    expect(
      canEditRolePermission(tech, roleDef('admin_tecnico'), perm('system:config'), 'remove')
        .allowed,
    ).toBe(true);
  });
});
