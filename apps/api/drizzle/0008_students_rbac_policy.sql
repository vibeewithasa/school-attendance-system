-- eta15:allow-destructive
-- Politica RBAC de alumnos del MVP (PROPUESTA TECNICA, pendiente de ratificacion institucional). Convierte en migracion la
-- propuesta que se discutio durante el desarrollo del modulo (ya no existe como archivo aparte: no se ejecuta manualmente).
--
-- POR QUE: la semilla 0004 concedio lectura GLOBAL de alumnos a roles cuyas funciones aun no define la institucion:
--     trabajo_social : students:read_basic (all) y students:read (all)
--     control_acceso : students:read_basic (all)
--   El modulo de alumnos autoriza por el permiso EFECTIVO: con esas asignaciones esos roles verian a TODOS los alumnos en cuanto
--   existan cuentas. La politica del MVP es alumnos CERRADO por defecto:
--     direccion      : students:read_basic, students:read, students:manage, enrollments:manage (alcance all). Sin cambios.
--     admin_tecnico  : ninguno (sin acceso a expedientes; la FK de dominio ya impide que reciba permisos de dominio school).
--     prefectura     : students:read_basic y students:read con alcance assigned_groups. Sin cambios: mientras no existan
--                      asignaciones reales de grupos a prefectura ve CERO filas (no hay acceso global).
--     trabajo_social : ninguno hasta definir funciones concretas y los datos que necesita.
--     control_acceso : ninguno hasta que exista el control de acceso con datos MINIMOS.
--   Los permisos NO se eliminan: siguen definidos y asignables por migracion cuando la institucion lo decida.
--
-- Cambios (solo datos de configuracion; ninguna tabla, usuario, sesion ni funcion; no se tocan 0000-0007):
--   * 3 bajas de role_permissions, auditadas por el trigger role_permissions_audit (evento role.permissions_changed):
--     3 eventos (trabajo_social x2, control_acceso x1).
-- La marca de la primera linea se justifica UNICAMENTE por los dos DELETE FROM role_permissions de abajo (bajas de asignaciones
-- concretas, reversibles con una migracion nueva); no hay DROP, TRUNCATE, ALTER ni borrado de roles, permisos, usuarios,
-- alumnos o auditoria. Es idempotente: sobre una base que ya no tiene esas asignaciones no cambia nada.

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" = 'trabajo_social' AND p."key" IN ('students:read_basic', 'students:read');--> statement-breakpoint

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" = 'control_acceso' AND p."key" = 'students:read_basic';--> statement-breakpoint

-- Verificacion final: si el resultado no es el esperado, la migracion completa se revierte.
DO $$
DECLARE
  v_n integer;
BEGIN
  -- Solo direccion (all) y prefectura (assigned_groups, solo lectura) tienen permisos de alumnos o matriculas.
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE (p."key" LIKE 'students:%' OR p."key" LIKE 'enrollments:%')
     AND r."key" NOT IN ('direccion', 'prefectura');
  IF v_n <> 0 THEN RAISE EXCEPTION '0008: solo direccion y prefectura conservan permisos de alumnos'; END IF;

  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'direccion' AND rp."scope" = 'all'
     AND p."key" IN ('students:read_basic', 'students:read', 'students:manage', 'enrollments:manage');
  IF v_n <> 4 THEN RAISE EXCEPTION '0008: direccion debe conservar los cuatro permisos de alumnos (all)'; END IF;

  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'prefectura' AND (p."key" LIKE 'students:%' OR p."key" LIKE 'enrollments:%')
     AND (rp."scope" <> 'assigned_groups' OR p."key" NOT IN ('students:read_basic', 'students:read'));
  IF v_n <> 0 THEN RAISE EXCEPTION '0008: prefectura solo lee alumnos con alcance assigned_groups'; END IF;

  -- Los permisos siguen definidos (no se eliminan).
  SELECT count(*) INTO v_n FROM "permissions"
   WHERE "key" IN ('students:read_basic', 'students:read', 'students:manage', 'enrollments:manage');
  IF v_n <> 4 THEN RAISE EXCEPTION '0008: los permisos de alumnos deben seguir definidos'; END IF;
END
$$;
