import {
  allowsGroup,
  resolveAccess,
  type Access,
  type Grant,
  type GroupAssignments,
} from './authorize.js';

/**
 * Contratos de autorizacion POR RECURSO y POR CAMPO. Son logica pura: las tablas de dominio (alumnos,
 * asistencia, asignaciones de prefectura) aun no existen y aqui no se inventa ninguna fila.
 *
 * Reglas que TODO endpoint de datos escolares debe cumplir (docs/architecture/auth-rbac.md §8):
 *  1. Autorizacion funcional: el usuario tiene el permiso (denegar por defecto).
 *  2. Autorizacion por recurso: el `groupId` se obtiene del REGISTRO guardado en la base de datos (nunca de la
 *     peticion) y se comprueba con `authorizeGroupResource`. Cambiar un UUID en la URL o el cuerpo no cambia nada.
 *  3. Listados: el filtro de alcance se aplica EN LA CONSULTA con `queryFilter`; un conjunto vacio significa
 *     "ninguna fila", jamas "sin filtro".
 *  4. Campos sensibles: la respuesta se proyecta con `projectFields` segun los permisos del usuario.
 *  5. Todo se evalua en cada peticion con datos frescos: cuenta activa, roles vigentes y asignaciones vigentes.
 *     Una cuenta deshabilitada, un rol revocado o una asignacion de grupo revocada niegan de inmediato.
 *  6. Un recurso fuera de alcance y uno inexistente deben ser indistinguibles para el cliente (misma respuesta).
 */

export interface Principal {
  userId: string;
  status: 'pending' | 'active' | 'disabled';
  /** Permisos vigentes de sus roles NO revocados, leidos de la base de datos en esta peticion. */
  grants: readonly Grant[];
}

export type DenyReason = 'inactive' | 'no_permission' | 'out_of_scope' | 'unknown_resource';
export type ResourceDecision =
  { allowed: true; access: Access } | { allowed: false; reason: DenyReason };

const denied = (reason: DenyReason): ResourceDecision => ({ allowed: false, reason });

/** Autoriza el acceso a UN registro que pertenece a un grupo. `groupId` debe venir de la base, no del cliente. */
export async function authorizeGroupResource(
  principal: Principal,
  permission: string,
  groupId: string | null | undefined,
  date: string,
  assignments: GroupAssignments,
): Promise<ResourceDecision> {
  if (principal.status !== 'active') return denied('inactive');
  const access = await resolveAccess(
    principal.grants,
    permission,
    principal.userId,
    date,
    assignments,
  );
  if (access.kind === 'denied') return denied('no_permission');
  if (!groupId) return denied('unknown_resource');
  if (access.kind === 'own') return denied('out_of_scope'); // 'own' no aplica a recursos de grupo
  return allowsGroup(access, groupId) ? { allowed: true, access } : denied('out_of_scope');
}

/** Operaciones en lote: TODO o nada (un solo grupo fuera de alcance rechaza la operacion completa). */
export async function authorizeGroupResources(
  principal: Principal,
  permission: string,
  groupIds: readonly (string | null | undefined)[],
  date: string,
  assignments: GroupAssignments,
): Promise<ResourceDecision> {
  if (groupIds.length === 0) return denied('unknown_resource');
  let last: ResourceDecision = denied('unknown_resource');
  for (const groupId of groupIds) {
    last = await authorizeGroupResource(principal, permission, groupId, date, assignments);
    if (!last.allowed) return last;
  }
  return last;
}

/** Que debe aplicar la capa de datos en un listado. */
export type QueryFilter =
  | { type: 'none' } // devolver CERO filas (no es "sin filtro")
  | { type: 'all' }
  | { type: 'groups'; groupIds: readonly string[] }
  | { type: 'own'; userId: string };

export function queryFilter(access: Access): QueryFilter {
  switch (access.kind) {
    case 'denied':
      return { type: 'none' };
    case 'all':
      return { type: 'all' };
    case 'groups':
      return access.groupIds.size === 0
        ? { type: 'none' }
        : { type: 'groups', groupIds: [...access.groupIds].sort() };
    case 'own':
      return { type: 'own', userId: access.userId };
  }
}

/** Filtro de un listado para un usuario (cuenta inactiva => ninguna fila). */
export async function listFilter(
  principal: Principal,
  permission: string,
  date: string,
  assignments: GroupAssignments,
): Promise<QueryFilter> {
  if (principal.status !== 'active') return { type: 'none' };
  return queryFilter(
    await resolveAccess(principal.grants, permission, principal.userId, date, assignments),
  );
}

/** Campo -> permiso requerido para verlo. Un campo sin entrada NO se devuelve (denegar por defecto). */
export type FieldSpec = Readonly<Record<string, string>>;

export function projectFields<T extends Record<string, unknown>>(
  record: T,
  spec: FieldSpec,
  principal: Principal,
): Partial<T> {
  if (principal.status !== 'active') return {};
  const held = new Set(principal.grants.map((g) => g.permission));
  const out: Partial<T> = {};
  for (const key of Object.keys(record) as (keyof T & string)[]) {
    const required = spec[key];
    if (required && held.has(required)) out[key] = record[key];
  }
  return out;
}
