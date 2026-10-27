/**
 * Catalogo de permisos y roles de ETA 15 (fuente de verdad en codigo).
 * La migracion 0005_auth_seed_roles_permissions lo siembra en la BD; la prueba
 * test/auth-seed.test.ts verifica que ambos coinciden. Ver docs/architecture/auth-rbac.md.
 */

export type RoleDomain = 'school' | 'technical';
export type PermissionDomain = RoleDomain | 'shared';
/**
 * Alcance de un permiso concedido a un rol:
 *  - all:             todos los registros del recurso.
 *  - assigned_groups: registros de los grupos con asignacion vigente del usuario (sin asignaciones => ninguno).
 *  - own:             registros propios del usuario.
 */
export type Scope = 'all' | 'assigned_groups' | 'own';

export interface PermissionDef {
  key: string;
  domain: PermissionDomain;
  description: string;
  /** Scopes que el permiso admite al concederse a un rol. */
  scopes: readonly Scope[];
  /** true = permiso de autoridad (ver AUTHORITY_PERMISSIONS). Lo fija AUTHORITY_PERMISSIONS, no cada entrada. */
  authority?: boolean;
}

const ALL = ['all'] as const;
const ALL_OR_GROUPS = ['all', 'assigned_groups'] as const;
const GROUPS = ['assigned_groups'] as const;

const RAW_PERMISSIONS: readonly PermissionDef[] = [
  // Compartidos
  {
    key: 'catalog:read',
    domain: 'shared',
    description: 'Consultar ciclos escolares y grupos',
    scopes: ALL,
  },
  {
    key: 'users:read',
    domain: 'shared',
    description: 'Consultar cuentas (identidad, estado, roles; sin datos escolares)',
    scopes: ALL,
  },
  {
    key: 'roles:read',
    domain: 'shared',
    description: 'Consultar roles y sus permisos',
    scopes: ALL,
  },
  // Tecnicos
  {
    // Reservado y SIN asignar desde la migracion 0006: la administracion del catalogo escolar es de Direccion (catalog:manage_school).
    key: 'catalog:manage',
    domain: 'technical',
    description: 'Crear y modificar ciclos escolares y grupos',
    scopes: ALL,
  },
  {
    key: 'users:manage_technical',
    domain: 'technical',
    description: 'Alta, edicion, invitacion, recuperacion y reactivacion de cuentas tecnicas',
    scopes: ALL,
  },
  {
    key: 'users:disable_any',
    domain: 'technical',
    description: 'Deshabilitar cualquier cuenta (interruptor de seguridad; no concede acceso)',
    scopes: ALL,
  },
  {
    key: 'users:revoke_sessions_any',
    domain: 'technical',
    description: 'Revocar sesiones de cualquier cuenta (no concede acceso)',
    scopes: ALL,
  },
  {
    key: 'roles:grant_technical',
    domain: 'technical',
    description: 'Conceder y revocar roles tecnicos a otras cuentas',
    scopes: ALL,
  },
  {
    key: 'roles:manage_technical',
    domain: 'technical',
    description: 'Editar los permisos de roles tecnicos',
    scopes: ALL,
  },
  {
    key: 'audit:read',
    domain: 'technical',
    description: 'Consultar la auditoria de autenticacion y administracion',
    scopes: ALL,
  },
  {
    key: 'system:config',
    domain: 'technical',
    description: 'Configuracion tecnica del sistema',
    scopes: ALL,
  },
  // Escolares
  {
    key: 'catalog:manage_school',
    domain: 'school',
    description: 'Crear y modificar ciclos escolares y grupos (dominio escolar)',
    scopes: ALL,
  },
  {
    key: 'users:manage_school',
    domain: 'school',
    description: 'Alta, edicion, invitacion, recuperacion y reactivacion de cuentas escolares',
    scopes: ALL,
  },
  {
    key: 'roles:grant_school',
    domain: 'school',
    description: 'Conceder y revocar roles escolares a otras cuentas',
    scopes: ALL,
  },
  {
    key: 'roles:manage_school',
    domain: 'school',
    description: 'Editar los permisos de roles escolares',
    scopes: ALL,
  },
  {
    key: 'students:read_basic',
    domain: 'school',
    description: 'Datos basicos del alumno (nombre, grupo, foto)',
    scopes: ALL_OR_GROUPS,
  },
  {
    key: 'students:read',
    domain: 'school',
    description: 'Expediente del alumno',
    scopes: ALL_OR_GROUPS,
  },
  {
    key: 'students:manage',
    domain: 'school',
    description: 'Alta y modificacion de alumnos',
    scopes: ALL,
  },
  {
    key: 'enrollments:manage',
    domain: 'school',
    description: 'Matriculas y cambios de grupo',
    scopes: ALL,
  },
  {
    key: 'attendance:capture',
    domain: 'school',
    description: 'Capturar la lista diaria de asistencia',
    scopes: GROUPS,
  },
  {
    key: 'attendance:read',
    domain: 'school',
    description: 'Consultar asistencia',
    scopes: ALL_OR_GROUPS,
  },
  {
    key: 'attendance:correct',
    domain: 'school',
    description: 'Corregir asistencia ya capturada',
    scopes: ALL,
  },
  {
    key: 'justifications:read',
    domain: 'school',
    description: 'Consultar justificantes',
    scopes: ALL_OR_GROUPS,
  },
  {
    key: 'justifications:manage',
    domain: 'school',
    description: 'Registrar y resolver justificantes',
    scopes: ALL,
  },
  {
    key: 'access:scan',
    domain: 'school',
    description: 'Registrar entradas y salidas del plantel',
    scopes: ALL,
  },
  {
    key: 'access:read',
    domain: 'school',
    description: 'Consultar eventos de control de acceso',
    scopes: ALL,
  },
  {
    key: 'reports:read',
    domain: 'school',
    description: 'Estadisticas y reportes escolares',
    scopes: ALL,
  },
];

/** Permisos de autoridad: no se delegan ni se editan desde la API (solo por migracion / propietario del esquema). */
export const AUTHORITY_PERMISSIONS: ReadonlySet<string> = new Set([
  'users:manage_technical',
  'users:manage_school',
  'roles:grant_technical',
  'roles:grant_school',
  'roles:manage_technical',
  'roles:manage_school',
]);

export const PERMISSIONS: readonly PermissionDef[] = RAW_PERMISSIONS.map((p) => ({
  ...p,
  authority: AUTHORITY_PERMISSIONS.has(p.key),
}));

export interface RoleGrantDef {
  permission: string;
  scope: Scope;
}

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  domain: RoleDomain;
  requiresMfa: boolean;
  /** Politica de sesion aprobada: minutos de inactividad y de duracion absoluta. */
  sessionIdleMinutes: number;
  sessionAbsoluteMinutes: number;
  /** Tope de sesiones concurrentes (el trigger de BD toma el menor entre los roles del usuario). */
  maxConcurrentSessions: number;
  grants: readonly RoleGrantDef[];
}

const g = (permission: string, scope: Scope = 'all'): RoleGrantDef => ({ permission, scope });

export const ROLES: readonly RoleDef[] = [
  {
    key: 'prefectura',
    name: 'Prefectura',
    description: 'Captura y consulta la asistencia diaria de los grupos que tiene asignados',
    domain: 'school',
    requiresMfa: false,
    sessionIdleMinutes: 60,
    sessionAbsoluteMinutes: 720,
    maxConcurrentSessions: 5,
    grants: [
      // Sin catalog:read global (0006): se concedera cuando exista el requerimiento, con alcance assigned_groups ya aplicado.
      g('students:read_basic', 'assigned_groups'),
      g('students:read', 'assigned_groups'),
      g('attendance:capture', 'assigned_groups'),
      g('attendance:read', 'assigned_groups'),
      g('justifications:read', 'assigned_groups'),
    ],
  },
  {
    key: 'trabajo_social',
    name: 'Trabajo social',
    description: 'Gestiona justificantes y consulta expedientes y asistencia',
    domain: 'school',
    requiresMfa: false,
    sessionIdleMinutes: 60,
    sessionAbsoluteMinutes: 720,
    maxConcurrentSessions: 5,
    grants: [
      g('students:read_basic'),
      g('students:read'),
      g('attendance:read'),
      g('justifications:read'),
      g('justifications:manage'),
    ],
  },
  {
    key: 'control_acceso',
    name: 'Control de acceso',
    description: 'Registra entradas y salidas del plantel',
    domain: 'school',
    requiresMfa: false,
    sessionIdleMinutes: 60,
    sessionAbsoluteMinutes: 720,
    maxConcurrentSessions: 5,
    grants: [g('students:read_basic'), g('access:scan'), g('access:read')],
  },
  {
    key: 'direccion',
    name: 'Direccion',
    description:
      'Autoriza el acceso escolar sensible, administra cuentas escolares y consulta reportes',
    domain: 'school',
    requiresMfa: true,
    sessionIdleMinutes: 30,
    sessionAbsoluteMinutes: 480,
    maxConcurrentSessions: 5,
    grants: [
      g('catalog:read'),
      g('catalog:manage_school'),
      g('users:read'),
      g('roles:read'),
      g('users:manage_school'),
      g('roles:grant_school'),
      g('roles:manage_school'),
      g('students:read_basic'),
      g('students:read'),
      g('students:manage'),
      g('enrollments:manage'),
      g('attendance:read'),
      g('attendance:correct'),
      g('justifications:read'),
      g('access:read'),
      g('reports:read'),
    ],
  },
  {
    key: 'admin_tecnico',
    name: 'Administracion tecnica',
    description: 'Configuracion y soporte; sin acceso a datos escolares',
    domain: 'technical',
    requiresMfa: true,
    sessionIdleMinutes: 15,
    sessionAbsoluteMinutes: 480,
    maxConcurrentSessions: 5,
    grants: [
      // Sin catalog:read ni catalog:manage (0006): el catalogo escolar no necesita permisos tecnicos.
      g('users:read'),
      g('roles:read'),
      g('users:manage_technical'),
      g('users:disable_any'),
      g('users:revoke_sessions_any'),
      g('roles:grant_technical'),
      g('roles:manage_technical'),
      g('audit:read'),
      g('system:config'),
    ],
  },
];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

/** Valida internamente el catalogo (usado por las pruebas y util antes de sembrar). */
export function catalogProblems(): string[] {
  const problems: string[] = [];
  const perms = new Map(PERMISSIONS.map((p) => [p.key, p]));
  if (perms.size !== PERMISSIONS.length) problems.push('permisos duplicados');
  if (new Set(ROLES.map((r) => r.key)).size !== ROLES.length) problems.push('roles duplicados');
  for (const role of ROLES) {
    if (role.sessionIdleMinutes > role.sessionAbsoluteMinutes)
      problems.push(`${role.key}: idle > absoluto`);
    for (const grant of role.grants) {
      const p = perms.get(grant.permission);
      if (!p) problems.push(`${role.key}: permiso inexistente ${grant.permission}`);
      else {
        if (p.domain !== 'shared' && p.domain !== role.domain) {
          problems.push(`${role.key}: permiso ${p.key} de otro dominio (${p.domain})`);
        }
        if (!p.scopes.includes(grant.scope)) {
          problems.push(`${role.key}: ${p.key} no admite el scope ${grant.scope}`);
        }
      }
    }
  }
  return problems;
}
