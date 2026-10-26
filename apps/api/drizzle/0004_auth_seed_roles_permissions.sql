-- Semilla de roles y permisos (datos de configuracion; NO crea usuarios ni contrasenas).
-- Idempotente: ON CONFLICT DO NOTHING; nunca sobrescribe cambios hechos despues. Los cambios futuros
-- al catalogo van en migraciones nuevas. Fuente de verdad: src/modules/access-control/catalog.ts
-- (la prueba test/auth-seed.test.ts verifica que coinciden).

INSERT INTO "permissions" ("key", "description", "domain", "is_authority") VALUES
  ('catalog:read', 'Consultar ciclos escolares y grupos', 'shared', false),
  ('users:read', 'Consultar cuentas (identidad, estado, roles; sin datos escolares)', 'shared', false),
  ('roles:read', 'Consultar roles y sus permisos', 'shared', false),
  ('catalog:manage', 'Crear y modificar ciclos escolares y grupos', 'technical', false),
  ('users:manage_technical', 'Alta, edicion, invitacion, recuperacion y reactivacion de cuentas tecnicas', 'technical', true),
  ('users:disable_any', 'Deshabilitar cualquier cuenta (interruptor de seguridad; no concede acceso)', 'technical', false),
  ('users:revoke_sessions_any', 'Revocar sesiones de cualquier cuenta (no concede acceso)', 'technical', false),
  ('roles:grant_technical', 'Conceder y revocar roles tecnicos a otras cuentas', 'technical', true),
  ('roles:manage_technical', 'Editar los permisos de roles tecnicos', 'technical', true),
  ('audit:read', 'Consultar la auditoria de autenticacion y administracion', 'technical', false),
  ('system:config', 'Configuracion tecnica del sistema', 'technical', false),
  ('users:manage_school', 'Alta, edicion, invitacion, recuperacion y reactivacion de cuentas escolares', 'school', true),
  ('roles:grant_school', 'Conceder y revocar roles escolares a otras cuentas', 'school', true),
  ('roles:manage_school', 'Editar los permisos de roles escolares', 'school', true),
  ('students:read_basic', 'Datos basicos del alumno (nombre, grupo, foto)', 'school', false),
  ('students:read', 'Expediente del alumno', 'school', false),
  ('students:manage', 'Alta y modificacion de alumnos', 'school', false),
  ('enrollments:manage', 'Matriculas y cambios de grupo', 'school', false),
  ('attendance:capture', 'Capturar la lista diaria de asistencia', 'school', false),
  ('attendance:read', 'Consultar asistencia', 'school', false),
  ('attendance:correct', 'Corregir asistencia ya capturada', 'school', false),
  ('justifications:read', 'Consultar justificantes', 'school', false),
  ('justifications:manage', 'Registrar y resolver justificantes', 'school', false),
  ('access:scan', 'Registrar entradas y salidas del plantel', 'school', false),
  ('access:read', 'Consultar eventos de control de acceso', 'school', false),
  ('reports:read', 'Estadisticas y reportes escolares', 'school', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "roles" ("key", "name", "description", "domain", "is_system", "requires_mfa", "session_idle_minutes", "session_absolute_minutes", "max_concurrent_sessions") VALUES
  ('prefectura', 'Prefectura', 'Captura y consulta la asistencia diaria de los grupos que tiene asignados', 'school', true, false, 60, 720, 5),
  ('trabajo_social', 'Trabajo social', 'Gestiona justificantes y consulta expedientes y asistencia', 'school', true, false, 60, 720, 5),
  ('control_acceso', 'Control de acceso', 'Registra entradas y salidas del plantel', 'school', true, false, 60, 720, 5),
  ('direccion', 'Direccion', 'Autoriza el acceso escolar sensible, administra cuentas escolares y consulta reportes', 'school', true, true, 30, 480, 5),
  ('admin_tecnico', 'Administracion tecnica', 'Configuracion y soporte; sin acceso a datos escolares', 'technical', true, true, 15, 480, 5)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "role_domain", "permission_id", "permission_domain", "scope")
SELECT r."id", r."domain", p."id", p."domain", v."scope"
FROM (VALUES
  ('prefectura', 'catalog:read', 'all'),
  ('prefectura', 'students:read_basic', 'assigned_groups'),
  ('prefectura', 'students:read', 'assigned_groups'),
  ('prefectura', 'attendance:capture', 'assigned_groups'),
  ('prefectura', 'attendance:read', 'assigned_groups'),
  ('prefectura', 'justifications:read', 'assigned_groups'),
  ('trabajo_social', 'catalog:read', 'all'),
  ('trabajo_social', 'students:read_basic', 'all'),
  ('trabajo_social', 'students:read', 'all'),
  ('trabajo_social', 'attendance:read', 'all'),
  ('trabajo_social', 'justifications:read', 'all'),
  ('trabajo_social', 'justifications:manage', 'all'),
  ('control_acceso', 'catalog:read', 'all'),
  ('control_acceso', 'students:read_basic', 'all'),
  ('control_acceso', 'access:scan', 'all'),
  ('control_acceso', 'access:read', 'all'),
  ('direccion', 'catalog:read', 'all'),
  ('direccion', 'users:read', 'all'),
  ('direccion', 'roles:read', 'all'),
  ('direccion', 'users:manage_school', 'all'),
  ('direccion', 'roles:grant_school', 'all'),
  ('direccion', 'roles:manage_school', 'all'),
  ('direccion', 'students:read_basic', 'all'),
  ('direccion', 'students:read', 'all'),
  ('direccion', 'students:manage', 'all'),
  ('direccion', 'enrollments:manage', 'all'),
  ('direccion', 'attendance:read', 'all'),
  ('direccion', 'attendance:correct', 'all'),
  ('direccion', 'justifications:read', 'all'),
  ('direccion', 'access:read', 'all'),
  ('direccion', 'reports:read', 'all'),
  ('admin_tecnico', 'catalog:read', 'all'),
  ('admin_tecnico', 'users:read', 'all'),
  ('admin_tecnico', 'roles:read', 'all'),
  ('admin_tecnico', 'catalog:manage', 'all'),
  ('admin_tecnico', 'users:manage_technical', 'all'),
  ('admin_tecnico', 'users:disable_any', 'all'),
  ('admin_tecnico', 'users:revoke_sessions_any', 'all'),
  ('admin_tecnico', 'roles:grant_technical', 'all'),
  ('admin_tecnico', 'roles:manage_technical', 'all'),
  ('admin_tecnico', 'audit:read', 'all'),
  ('admin_tecnico', 'system:config', 'all')
) AS v("role_key", "permission_key", "scope")
JOIN "roles" r ON r."key" = v."role_key"
JOIN "permissions" p ON p."key" = v."permission_key"
ON CONFLICT ("role_id", "permission_id") DO NOTHING;