import type { AuthMeResponse } from '@eta15/shared-contracts';

export type Domain = 'school' | 'technical';
export const DOMAIN_LABELS: Record<Domain, string> = { school: 'Escolar', technical: 'Técnico' };
export const ROLE_LABELS: Record<string, string> = {
  prefectura: 'Prefectura',
  trabajo_social: 'Trabajo social',
  control_acceso: 'Control de acceso',
  direccion: 'Dirección',
  admin_tecnico: 'Administración técnica',
};
export const roleLabel = (key: string) => ROLE_LABELS[key] ?? key;

/**
 * Permisos EFECTIVOS segun la ultima respuesta de GET /auth/me. Solo sirven para decidir que controles mostrar: el servidor
 * vuelve a autorizar cada peticion, asi que ocultar un boton NUNCA sustituye esa comprobacion.
 */
export function permissionSet(me: AuthMeResponse): Set<string> {
  return new Set(me.permissions.map((p) => p.permission));
}

const DOMAINS: Domain[] = ['school', 'technical'];

export function permissionsOf(me: AuthMeResponse) {
  const has = permissionSet(me);
  /** Escritura: solo cuenta el permiso con alcance `all` (no existe "escribir solo mis grupos"). */
  const hasAll = (permission: string) =>
    me.permissions.some((p) => p.permission === permission && p.scope === 'all');
  const manageable = DOMAINS.filter((d) => has.has(`users:manage_${d}`));
  const grantable = DOMAINS.filter((d) => has.has(`roles:grant_${d}`));
  return {
    /** Dominios cuyas cuentas puede ver y administrar. */
    manageable,
    /** Dominios en los que puede asignar y revocar roles. */
    grantable,
    canViewPersonnel: has.has('users:read') && manageable.length > 0,
    /** Catalogo escolar: leer o administrar ciclos y grupos (solo presentacion; el servidor autoriza). */
    canViewCatalog: has.has('catalog:read'),
    canManageCatalog: has.has('catalog:manage_school'),
    /** Alumnos (solo presentacion; el servidor autoriza y aplica el alcance por grupo). */
    canViewStudents: has.has('students:read_basic'),
    canViewStudentFile: has.has('students:read'),
    canManageStudents: hasAll('students:manage'),
    canManageEnrollments: hasAll('enrollments:manage'),
    canCreate: (domain: Domain) => has.has(`users:manage_${domain}`),
    canGrant: (domain: Domain) => has.has(`roles:grant_${domain}`),
    canDisable: (domain: Domain) =>
      has.has(`users:manage_${domain}`) || has.has('users:disable_any'),
  };
}
