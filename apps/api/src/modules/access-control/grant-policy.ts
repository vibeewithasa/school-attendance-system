import type { PermissionDomain, RoleDomain } from './catalog.js';

/**
 * Reglas de separacion de funciones para conceder privilegios. Se aplican en el servicio ANTES de
 * escribir; los triggers de la migracion 0004 son la ultima defensa en la base de datos.
 * Todo es denegar por defecto.
 */

export interface Actor {
  id: string;
  status: 'pending' | 'active' | 'disabled';
  /** Permisos vigentes del actor (de sus roles no revocados). */
  permissions: ReadonlySet<string>;
  /** Claves de roles vigentes del actor. */
  roleKeys: ReadonlySet<string>;
}

export interface TargetAccount {
  id: string;
  status: 'pending' | 'active' | 'disabled';
  accountDomain: RoleDomain;
}

export type Decision = { allowed: true } | { allowed: false; reason: string };
const deny = (reason: string): Decision => ({ allowed: false, reason });
const ok: Decision = { allowed: true };

/** Conceder o revocar un rol a otra cuenta. */
export function canGrantRole(
  actor: Actor,
  target: TargetAccount,
  role: { key: string; domain: RoleDomain },
): Decision {
  if (actor.status !== 'active') return deny('el actor no esta activo');
  if (actor.id === target.id) return deny('nadie puede concederse roles a si mismo');
  if (target.status === 'disabled') return deny('la cuenta destino esta deshabilitada');
  if (role.domain !== target.accountDomain)
    return deny('el dominio del rol no coincide con el de la cuenta');
  if (!actor.permissions.has(`roles:grant_${role.domain}`)) {
    return deny(`falta el permiso roles:grant_${role.domain}`);
  }
  return ok;
}

/** Revocar un rol: igual que conceder, salvo que renunciar a un rol propio siempre se permite. */
export function canRevokeRole(
  actor: Actor,
  target: TargetAccount,
  role: { key: string; domain: RoleDomain },
): Decision {
  if (actor.id === target.id)
    return actor.status === 'active' ? ok : deny('el actor no esta activo');
  return canGrantRole(actor, target, role);
}

export type AccountAction =
  | 'create'
  | 'update'
  | 'issue_invite'
  | 'reset_credentials'
  | 'enable'
  | 'disable'
  | 'revoke_sessions';

/**
 * Gestion de cuentas. Cada dominio administra sus propias cuentas; las acciones que solo reducen acceso
 * (deshabilitar, revocar sesiones) las puede hacer tambien el administrador tecnico sobre cualquier cuenta.
 */
export function canManageAccount(
  actor: Actor,
  target: Pick<TargetAccount, 'id' | 'accountDomain'>,
  action: AccountAction,
): Decision {
  if (actor.status !== 'active') return deny('el actor no esta activo');
  if (actor.permissions.has(`users:manage_${target.accountDomain}`)) {
    if (action === 'reset_credentials' && actor.id === target.id) {
      return deny('use el flujo de cambio de contrasena para su propia cuenta');
    }
    return ok;
  }
  if (action === 'disable' && actor.permissions.has('users:disable_any')) {
    return actor.id === target.id ? deny('no puede deshabilitarse a si mismo') : ok;
  }
  if (action === 'revoke_sessions' && actor.permissions.has('users:revoke_sessions_any')) return ok;
  return deny(`falta users:manage_${target.accountDomain}`);
}

/**
 * Editar los permisos de un rol desde la API. Requiere roles:manage_<dominio del rol>; el permiso debe ser
 * del mismo dominio o compartido; los permisos de AUTORIDAD (conceder roles, administrar cuentas, editar roles)
 * nunca se delegan por aqui; y nadie puede AGREGAR permisos a un rol que el mismo posee (quitar si).
 */
export function canEditRolePermission(
  actor: Actor,
  role: { key: string; domain: RoleDomain },
  permission: { key: string; domain: PermissionDomain; authority?: boolean },
  change: 'add' | 'remove',
): Decision {
  if (actor.status !== 'active') return deny('el actor no esta activo');
  if (!actor.permissions.has(`roles:manage_${role.domain}`))
    return deny(`falta roles:manage_${role.domain}`);
  if (permission.authority) {
    return deny(
      'los permisos de autoridad no se delegan ni se editan desde la API (solo por migracion)',
    );
  }
  if (permission.domain !== 'shared' && permission.domain !== role.domain) {
    return deny('el permiso pertenece a otro dominio');
  }
  if (change === 'add' && actor.roleKeys.has(role.key)) {
    return deny('no puede ampliar los permisos de un rol que usted posee');
  }
  return ok;
}
