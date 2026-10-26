import type { Scope } from './catalog.js';

/** Un permiso concedido a un usuario por alguno de sus roles vigentes. */
export interface Grant {
  permission: string;
  scope: Scope;
}

/** Resultado de autorizar: deniega por defecto. */
export type Access =
  | { kind: 'denied' }
  | { kind: 'all' }
  | { kind: 'groups'; groupIds: ReadonlySet<string> }
  | { kind: 'own'; userId: string };

/** Puerto hacia las asignaciones vigentes (futura tabla prefect_group_assignments). */
export interface GroupAssignments {
  groupIdsFor(userId: string, date: string): Promise<readonly string[]>;
}

/**
 * Resuelve el acceso de un usuario a un recurso protegido por `permission`.
 * - Sin ningun grant del permiso => denied (denegar por defecto).
 * - Si algun rol concede `all`, ese alcance domina.
 * - `assigned_groups` => conjunto de grupos con asignacion vigente en `date` (vacio si no hay: no es un error).
 * - `own` => registros propios.
 * La capa de datos DEBE aplicar este resultado en la consulta (WHERE group_id = ANY(...)); no filtrar despues.
 */
export async function resolveAccess(
  grants: readonly Grant[],
  permission: string,
  userId: string,
  date: string,
  assignments: GroupAssignments,
): Promise<Access> {
  const own = grants.filter((g) => g.permission === permission);
  if (own.length === 0) return { kind: 'denied' };
  if (own.some((g) => g.scope === 'all')) return { kind: 'all' };
  const groupIds = new Set<string>();
  let hasGroups = false;
  for (const g of own) {
    if (g.scope === 'assigned_groups') {
      hasGroups = true;
      for (const id of await assignments.groupIdsFor(userId, date)) groupIds.add(id);
    }
  }
  if (hasGroups) return { kind: 'groups', groupIds };
  return { kind: 'own', userId };
}

/** ¿El acceso resuelto permite ver un registro de este grupo? */
export function allowsGroup(access: Access, groupId: string): boolean {
  return access.kind === 'all' || (access.kind === 'groups' && access.groupIds.has(groupId));
}
